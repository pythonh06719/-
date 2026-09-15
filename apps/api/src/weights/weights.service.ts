import { Injectable } from '@nestjs/common';

import { round2 } from '@qsh/core';
import type { MovingAveragePoint, WeightLog } from '@qsh/shared-types';

import { toWeightLog } from '../common/mappers/entity.mapper';
import { addDays, todayLocalKey } from '../common/utils/date.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWeightDto } from './dto/create-weight.dto';

/** 体重趋势（含 7 日移动平均，服务端算好，前端只渲染）。 */
export interface WeightListResult {
  logs: WeightLog[];
  /**
   * 7 日移动平均数据点（与 `logs` 日期对齐，升序）。
   * 字段名与契约 `WeightTrendResponse.movingAverage7` 一致（QA BUG-02）：
   * 不再使用 `movingAverage7d`，避免两个端点两套命名。
   */
  movingAverage7: MovingAveragePoint[];
  /** 原始趋势点（升序） */
  points: Array<{ date: string; weightKg: number }>;
  /** 区间统计 */
  stats: {
    minKg: number | null;
    maxKg: number | null;
    latestKg: number | null;
    changeKg: number | null;
  };
}

/** 移动平均窗口长度（天）。 */
const MOVING_AVERAGE_WINDOW = 7;

/**
 * 体重服务（R7.1 / R7.2）。
 *
 * - 记录：`(user_id, logged_at)` 同日唯一，重复即覆盖（TC-34 / §9.3）；
 * - 查询：服务端计算 **7 日移动平均线**（前端只负责渲染）；
 * - 联动：当写入的是**最新一天**的体重时，同步更新当前目标的 `start_weight_kg`
 *   并追加一条 `weight_goal_history`（保证看板预算反映最新体重）。
 */
@Injectable()
export class WeightsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 记录体重（同日覆盖）。 */
  async create(userId: number, dto: CreateWeightDto): Promise<WeightLog> {
    const loggedAt = dto.loggedAt ?? todayLocalKey();

    const row = await this.prisma.weightLog.upsert({
      where: { userId_loggedAt: { userId, loggedAt } },
      create: {
        userId,
        loggedAt,
        weightKg: dto.weightKg,
        note: dto.note ?? null,
        source: dto.source ?? 'manual',
      },
      update: {
        weightKg: dto.weightKg,
        note: dto.note ?? null,
        ...(dto.source !== undefined ? { source: dto.source } : {}),
        updatedAt: new Date().toISOString(),
      },
    });

    await this.syncGoalWithLatestWeight(userId, loggedAt, dto.weightKg);

    return toWeightLog(row);
  }

  /** 查询近 `days` 天体重 + 7 日移动平均 + 统计。 */
  async list(userId: number, days = 90): Promise<WeightListResult> {
    const today = todayLocalKey();
    const since = addDays(today, -(days - 1));

    const rows = await this.prisma.weightLog.findMany({
      where: { userId, loggedAt: { gte: since, lte: today } },
      orderBy: { loggedAt: 'asc' },
    });
    const logs = rows.map(toWeightLog);

    const movingAverage7: MovingAveragePoint[] = logs.map((log) => ({
      date: log.loggedAt,
      value: round2(this.averageWindow(logs, log.loggedAt)),
    }));

    const points = logs.map((log) => ({ date: log.loggedAt, weightKg: log.weightKg }));

    let minKg: number | null = null;
    let maxKg: number | null = null;
    let latestKg: number | null = null;
    for (const log of logs) {
      minKg = minKg === null ? log.weightKg : Math.min(minKg, log.weightKg);
      maxKg = maxKg === null ? log.weightKg : Math.max(maxKg, log.weightKg);
      latestKg = log.weightKg;
    }
    const firstKg = logs.length > 0 ? logs[0]!.weightKg : null;
    const changeKg =
      firstKg === null || latestKg === null ? null : round2(latestKg - firstKg);

    return { logs, movingAverage7, points, stats: { minKg, maxKg, latestKg, changeKg } };
  }

  /** 近 `days` 天的迷你趋势（缺失日期补 `null`，供看板）。 */
  async miniTrend(userId: number, days = 7): Promise<Array<{ date: string; weightKg: number | null }>> {
    const today = todayLocalKey();
    const since = addDays(today, -(days - 1));

    const rows = await this.prisma.weightLog.findMany({
      where: { userId, loggedAt: { gte: since, lte: today } },
      select: { loggedAt: true, weightKg: true },
    });
    const byDate = new Map<string, number>(rows.map((row) => [row.loggedAt, row.weightKg]));

    const result: Array<{ date: string; weightKg: number | null }> = [];
    for (let offset = 0; offset < days; offset += 1) {
      const date = addDays(since, offset);
      result.push({ date, weightKg: byDate.get(date) ?? null });
    }
    return result;
  }

  /** 计算某日往前 7 天窗口内的平均体重（不足 7 天按已有点计算）。 */
  private averageWindow(logs: WeightLog[], endDate: string): number {
    const start = addDays(endDate, -(MOVING_AVERAGE_WINDOW - 1));
    let sum = 0;
    let count = 0;
    for (const log of logs) {
      if (log.loggedAt >= start && log.loggedAt <= endDate) {
        sum += log.weightKg;
        count += 1;
      }
    }
    return count === 0 ? 0 : sum / count;
  }

  /**
   * 若本次写入的是最新一天的数据，则把当前目标的起始体重同步为该值，并追加目标历史。
   * 回填历史日期时不会改动当前目标。
   */
  private async syncGoalWithLatestWeight(
    userId: number,
    loggedAt: string,
    weightKg: number,
  ): Promise<void> {
    const newerCount = await this.prisma.weightLog.count({
      where: { userId, loggedAt: { gt: loggedAt } },
    });
    if (newerCount > 0) {
      return;
    }

    const goal = await this.prisma.userGoal.findUnique({ where: { userId } });
    if (!goal || Math.abs(goal.startWeightKg - weightKg) < 1e-9) {
      return;
    }

    const nowIso = new Date().toISOString();
    await this.prisma.$transaction([
      this.prisma.userGoal.update({
        where: { userId },
        data: { startWeightKg: weightKg, updatedAt: nowIso },
      }),
      this.prisma.weightGoalHistory.create({
        data: {
          userId,
          startWeightKg: weightKg,
          targetWeightKg: goal.targetWeightKg,
          targetWeeks: goal.targetWeeks,
          weeklyLossKg: goal.weeklyLossKg,
          macroRatio: goal.macroRatio,
          effectiveFrom: loggedAt,
        },
      }),
    ]);
  }
}
