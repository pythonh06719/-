import { Injectable } from '@nestjs/common';

import type { DashboardResponse, MiniTrendPoint } from '@qsh/shared-types';

import { todayLocalKey } from '../common/utils/date.util';
import { MealsService } from '../meals/meals.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { WeightsService } from '../weights/weights.service';
import { buildEncouragement } from './encouragement';

/** 看板迷你趋势天数。 */
const MINI_TREND_DAYS = 7;

/**
 * 今日看板聚合（US-05 / R3.10）。
 *
 * 「今日目标 − 已摄入 = 剩余」由服务端一次算好，前端只渲染；饮水一期读 `water_logs`（可能为空表）。
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly mealsService: MealsService,
    private readonly weightsService: WeightsService,
  ) {}

  /** 聚合当日看板数据。 */
  async get(userId: number, date?: string): Promise<DashboardResponse> {
    const targetDate = date ?? todayLocalKey();

    const profile = await this.usersService.getProfile(userId);
    const budget = profile.budget;
    const goal = profile.goal;
    const settings = profile.settings;

    const [dayTotals, waterAgg, exerciseAgg, miniTrend] = await Promise.all([
      this.mealsService.dayTotals(userId, targetDate),
      this.prisma.waterLog.aggregate({
        _sum: { amountMl: true },
        where: { userId, loggedDate: targetDate },
      }),
      this.prisma.exerciseLog.aggregate({
        _sum: { kcalBurned: true },
        where: { userId, loggedDate: targetDate },
      }),
      this.weightsService.miniTrend(userId, MINI_TREND_DAYS),
    ]);

    const intakeRecommended = budget?.intakeRecommended ?? 0;
    const intakeKcal = dayTotals.kcal;
    const burnedKcal = exerciseAgg._sum.kcalBurned ?? 0;
    const remainingKcal = intakeRecommended - intakeKcal;
    const progressRatio = intakeRecommended > 0 ? intakeKcal / intakeRecommended : 0;

    const mini: MiniTrendPoint[] = miniTrend.map((point) => ({
      date: point.date,
      weightKg: point.weightKg,
    }));

    return {
      date: targetDate,
      goal: goal ?? null,
      budget: budget
        ? {
            intakeRecommended: budget.intakeRecommended,
            bmr: budget.bmr,
            tdee: budget.tdee,
          }
        : null,
      intakeKcal,
      burnedKcal,
      remainingKcal,
      progressRatio,
      waterMl: waterAgg._sum.amountMl ?? 0,
      waterGoalMl: settings.waterGoalMl,
      miniTrend: mini,
      encouragement: buildEncouragement(progressRatio, Boolean(goal)),
      warnings: budget?.warnings ?? [],
    };
  }
}
