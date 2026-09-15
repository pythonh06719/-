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

  /** 撤销上一条（按创建时间倒序取最新一条，仅本人）。 */
  async undoLast(userId: number, date?: string): Promise<{ undone: boolean; day: WaterDayResult }> {
    const day = date ?? todayLocalKey();
    const last = await this.prisma.waterLog.findFirst({
      where: { userId, loggedDate: day },
      orderBy: { id: 'desc' },
    });
    if (!last) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_WATER, '今天还没有可撤销的记录');
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
