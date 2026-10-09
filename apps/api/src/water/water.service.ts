import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { todayLocalKey } from '../common/utils/date.util';
import { CreateWaterDto, UpdateWaterGoalDto } from './dto/water.dto';

/** 默认单次水量（R6.3「一键 +250ml」）。 */
export const DEFAULT_WATER_ML = 250;

/** 饮水查询结果。 */
export interface WaterDayResult {
  date: string;
  totalMl: number;
  goalMl: number;
  logs: Array<{ id: number; amountMl: number; loggedAt: string }>;
}

/** 饮水服务（R6.3）：一键 +250ml、撤销上一条、自定义每日目标。 */
@Injectable()
export class WaterService {
  constructor(private readonly prisma: PrismaService) {}

  /** 查询某日饮水（缺省今天）。 */
  async listByDate(userId: number, date?: string): Promise<WaterDayResult> {
    const day = date ?? todayLocalKey();
    const [settings, rows] = await Promise.all([
      this.prisma.userSettings.findUnique({ where: { userId } }),
      this.prisma.waterLog.findMany({ where: { userId, loggedDate: day }, orderBy: { id: 'asc' } }),
    ]);

    return {
      date: day,
      totalMl: rows.reduce((sum, row) => sum + row.amountMl, 0),
      goalMl: settings?.waterGoalMl ?? 2000,
      logs: rows.map((row) => ({ id: row.id, amountMl: row.amountMl, loggedAt: row.loggedAt })),
    };
  }

  /** 记一笔饮水（缺省 250ml）。 */
  async create(userId: number, dto: CreateWaterDto): Promise<WaterDayResult> {
    const day = dto.loggedDate ?? todayLocalKey();
    await this.prisma.waterLog.create({
      data: {
        userId,
        loggedDate: day,
        loggedAt: new Date().toISOString(),
        amountMl: dto.amountMl ?? DEFAULT_WATER_ML,
      },
    });
    return this.listByDate(userId, day);
  }

  /**
   * 撤销上一条（按创建时间倒序取最新一条，仅本人）。
   *
   * ⚠️ 404 文案里的「哪一天」必须跟着 `day` 走：此前写死「今天还没有可撤销的记录」，
   * 于是 `DELETE /water/last?date=2026-12-31`（那天没记录）会把
   * 「2026-12-31 没记录」报成「今天没记录」—— 与「日期错被伪装成没记录」同源的误导。
   *
   * **为什么不抽到集中文案常量**：后端目前没有 `@/lib/copy` 那样的集中文案模块
   * （`common/constants/` 下只有 `error-codes.ts`），所有 ApiException 文案都是就近
   * 字面量；为这一条单独建一层会让「该去哪儿找文案」出现两种答案，反而更容易漂移。
   * 若将来后端引入集中文案，此处应一并搬迁。
   *
   * **语气红线（PRD §7）**：只陈述「这天还没有记录」，不出现失败/错误/警告，不催促。
   */
  async undoLast(userId: number, date?: string): Promise<{ undone: boolean; day: WaterDayResult }> {
    const today = todayLocalKey();
    const day = date ?? today;
    const last = await this.prisma.waterLog.findFirst({
      where: { userId, loggedDate: day },
      orderBy: { id: 'desc' },
    });
    if (!last) {
      // 解析后确实是今天（不传 date，或显式传了今天）才说「今天」；否则报出那一天的日期。
      // 判据取自 `day` 本身而非「调用方有没有传 date」，这样任何来源的空值/今天都不会说错。
      const dayLabel = day === today ? '今天' : `${day} 这天`;
      throw new ApiException(404, ERROR_CODES.NOTFOUND_WATER, `${dayLabel}还没有可撤销的饮水记录`);
    }
    await this.prisma.waterLog.delete({ where: { id: last.id } });
    return { undone: true, day: await this.listByDate(userId, day) };
  }

  /** 删除指定一条（仅本人）。 */
  async remove(userId: number, id: number): Promise<{ deleted: true }> {
    const row = await this.prisma.waterLog.findFirst({ where: { id, userId } });
    if (!row) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_WATER, '没有找到这条饮水记录');
    }
    await this.prisma.waterLog.delete({ where: { id } });
    return { deleted: true };
  }

  /** 自定义每日目标（R6.3）。 */
  async updateGoal(userId: number, dto: UpdateWaterGoalDto): Promise<{ waterGoalMl: number }> {
    await this.prisma.userSettings.update({
      where: { userId },
      data: { waterGoalMl: dto.waterGoalMl },
    });
    return { waterGoalMl: dto.waterGoalMl };
  }
}
