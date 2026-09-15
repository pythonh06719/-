import { Injectable } from '@nestjs/common';

import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { PrismaService } from '../prisma/prisma.service';

/** 断食设置（R8.1）。 */
export interface FastingSettingsDto {
  plan: string;
  targetFastHours: number;
  eatWindowStart: string | null;
  enabled: boolean;
  disclaimerAckAt: string | null;
}

/** 当前断食会话（含剩余时间，由服务端计算）。 */
export interface FastingSessionDto {
  id: number;
  plan: string;
  targetHours: number;
  startedAt: string;
  endedAt: string | null;
  completed: boolean;
  /** 已断食小时数（服务端按 UTC 时间戳计算） */
  elapsedHours: number;
  /** 剩余小时数（负数表示已达标） */
  remainingHours: number;
}

const PLAN_HOURS: Record<string, number> = { '16:8': 16, '18:6': 18, '20:4': 20 };

/** 断食服务（R8.1~R8.4，二期，默认关闭）。 */
@Injectable()
export class FastingService {
  constructor(private readonly prisma: PrismaService) {}

  /** 读取设置（不存在则返回默认关闭态）。 */
  async getSettings(userId: number): Promise<FastingSettingsDto> {
    const row = await this.prisma.fastingSettings.findUnique({ where: { userId } });
    return {
      plan: row?.plan ?? '16:8',
      targetFastHours: row?.targetFastHours ?? 16,
      eatWindowStart: row?.eatWindowStart ?? null,
      enabled: row?.enabled ?? false,
      disclaimerAckAt: row?.disclaimerAckAt ?? null,
    };
  }

  /**
   * 更新设置。
   * **服务端强制内容警告（R8.2 / TC-30）**：把 `enabled` 从 false 置 true，
   * 必须携带 `disclaimerAckAt`（前端必须先弹内容警告并取得用户确认）。
   */
  async updateSettings(userId: number, dto: import('./dto/fasting.dto').UpdateFastingSettingsDto): Promise<FastingSettingsDto> {
    const current = await this.getSettings(userId);
    const willEnable = dto.enabled ?? current.enabled;

    if (willEnable && !current.disclaimerAckAt && !dto.disclaimerAckAt) {
      throw new ApiException(400, ERROR_CODES.VALID_DISCLAIMER_REQUIRED, '开启前需要先阅读并确认内容警告');
    }

    const plan = dto.plan ?? current.plan;
    const targetFastHours =
      dto.targetFastHours ?? (plan === 'custom' ? (dto.targetFastHours ?? current.targetFastHours) : PLAN_HOURS[plan] ?? current.targetFastHours);

    await this.prisma.fastingSettings.upsert({
      where: { userId },
      create: {
        userId,
        plan,
        targetFastHours,
        eatWindowStart: dto.eatWindowStart ?? null,
        enabled: willEnable,
        disclaimerAckAt: dto.disclaimerAckAt ?? current.disclaimerAckAt,
      },
      update: {
        plan,
        targetFastHours,
        eatWindowStart: dto.eatWindowStart ?? current.eatWindowStart,
        enabled: willEnable,
        disclaimerAckAt: dto.disclaimerAckAt ?? current.disclaimerAckAt,
      },
    });
    return this.getSettings(userId);
  }

  /** 当前进行中的会话（无则返回 null；**不做任何主动推送**，R8.3）。 */
  async current(userId: number): Promise<FastingSessionDto | null> {
    const session = await this.prisma.fastingSession.findFirst({
      where: { userId, endedAt: null },
      orderBy: { id: 'desc' },
    });
    if (!session) {
      return null;
    }
    return this.toDto(session);
  }

  /** 开始一次断食（需设置已启用；未结束时不得重复开启）。 */
  async start(userId: number): Promise<FastingSessionDto> {
    const settings = await this.getSettings(userId);
    if (!settings.enabled) {
      throw new ApiException(400, ERROR_CODES.VALID_FASTING_DISABLED, '请先在设置里开启断食计时');
    }
    const running = await this.current(userId);
    if (running) {
      throw new ApiException(400, ERROR_CODES.VALID_FASTING_RUNNING, '已有一个进行中的断食');
    }
    const created = await this.prisma.fastingSession.create({
      data: {
        userId,
        plan: settings.plan,
        targetHours: settings.targetFastHours,
        startedAt: new Date().toISOString(),
        completed: false,
      },
    });
    return this.toDto(created);
  }

  /** 结束当前断食（是否达标由前端按 `remainingHours` 展示，服务端不做评判）。 */
  async stop(userId: number): Promise<FastingSessionDto> {
    const running = await this.current(userId);
    if (!running) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_FASTING, '当前没有进行中的断食');
    }
    const endedAt = new Date().toISOString();
    const updated = await this.prisma.fastingSession.update({
      where: { id: running.id },
      data: { endedAt, completed: (Date.now() - Date.parse(running.startedAt)) / 3600000 >= running.targetHours },
    });
    return this.toDto(updated);
  }

  private toDto(row: {
    id: number;
    plan: string;
    targetHours: number;
    startedAt: string;
    endedAt: string | null;
    completed: boolean;
  }): FastingSessionDto {
    const elapsedHours = (Date.now() - Date.parse(row.startedAt)) / 3600000;
    return {
      id: row.id,
      plan: row.plan,
      targetHours: row.targetHours,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      completed: row.completed,
      elapsedHours: Math.round(elapsedHours * 100) / 100,
      remainingHours: Math.round((row.targetHours - elapsedHours) * 100) / 100,
    };
  }
}
