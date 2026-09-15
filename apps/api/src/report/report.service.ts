import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { addDays, todayLocalKey } from '../common/utils/date.util';

/**
 * 微量营养素参考值（D7 默认：《中国居民膳食营养素参考摄入量》成人一般人群，DRI）。
 * 仅作参考条展示（R4.2「可选显示 DRI 参考条」），不构成营养诊断；
 * 钠 / 糖 / 饱和脂肪为「建议不超过」口径，其余为「建议达到」口径。
 */
export const DRI_REFERENCES = [
  { key: 'fiberG', name: '膳食纤维', unit: 'g', reference: 25, direction: 'atLeast' },
  { key: 'sodiumMg', name: '钠', unit: 'mg', reference: 1500, direction: 'atMost' },
  { key: 'sugarG', name: '糖', unit: 'g', reference: 50, direction: 'atMost' },
  { key: 'saturatedFatG', name: '饱和脂肪', unit: 'g', reference: 20, direction: 'atMost' },
  { key: 'calciumMg', name: '钙', unit: 'mg', reference: 800, direction: 'atLeast' },
  { key: 'ironMg', name: '铁', unit: 'mg', reference: 15, direction: 'atLeast' },
  { key: 'potassiumMg', name: '钾', unit: 'mg', reference: 2000, direction: 'atLeast' },
  { key: 'vitaminDUg', name: '维生素 D', unit: 'µg', reference: 10, direction: 'atLeast' },
  { key: 'b12Ug', name: '维生素 B12', unit: 'µg', reference: 2.4, direction: 'atLeast' },
  { key: 'magnesiumMg', name: '镁', unit: 'mg', reference: 330, direction: 'atLeast' },
] as const;

export type MicronutrientKey = (typeof DRI_REFERENCES)[number]['key'];

/** 单日汇总。 */
export interface ReportDay {
  date: string;
  intakeKcal: number;
  exerciseKcal: number;
  waterMl: number;
  habitsDone: number;
  habitsTotal: number;
}

/** 周报（R4.1 / R11.1）。 */
export interface WeeklyReport {
  from: string;
  to: string;
  days: ReportDay[];
  avgIntakeKcal: number;
  totalExerciseKcal: number;
  weightChangeKg: number | null;
  /** 微量营养素：10 项日均 + DRI 参考（R4.1 / R4.2） */
  micronutrients: Array<{ key: string; name: string; unit: string; dailyAvg: number; reference: number; direction: string }>;
  /** 参考来源声明（R2.8 数字可溯源） */
  referenceNote: string;
}

/** 周报服务（二期）。全部聚合在服务端完成，前端只渲染。 */
@Injectable()
export class ReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** 近 7 天（含 `endDate`）周报。 */
  async weekly(userId: number, endDate?: string): Promise<WeeklyReport> {
    const to = endDate ?? todayLocalKey();
    const from = addDays(to, -6);

    const [meals, exercises, waters, habits, weights, micronutrientRows] = await Promise.all([
      this.prisma.mealLog.findMany({
        where: { userId, loggedDate: { gte: from, lte: to } },
        select: { loggedDate: true, kcal: true },
      }),
      this.prisma.exerciseLog.findMany({
        where: { userId, loggedDate: { gte: from, lte: to } },
        select: { loggedDate: true, kcalBurned: true },
      }),
      this.prisma.waterLog.findMany({
        where: { userId, loggedDate: { gte: from, lte: to } },
        select: { loggedDate: true, amountMl: true },
      }),
      this.prisma.habitDefinition.findMany({
        where: { OR: [{ userId }, { userId: null }], isActive: true },
        select: { id: true },
      }),
      this.prisma.weightLog.findMany({
        where: { userId, loggedAt: { gte: from, lte: to } },
        orderBy: { loggedAt: 'asc' },
        select: { loggedAt: true, weightKg: true },
      }),
      this.micronutrientRows(userId, from, to),
    ]);

    const habitTotal = habits.length;
    const checked = await this.prisma.habitCheckin.findMany({
      where: { userId, loggedDate: { gte: from, lte: to }, done: true },
      select: { loggedDate: true, habitId: true },
    });

    const days: ReportDay[] = [];
    for (let index = 0; index < 7; index += 1) {
      const date = addDays(from, index);
      days.push({
        date,
        intakeKcal: this.round1(meals.filter((meal) => meal.loggedDate === date).reduce((sum, meal) => sum + meal.kcal, 0)),
        exerciseKcal: this.round1(exercises.filter((row) => row.loggedDate === date).reduce((sum, row) => sum + row.kcalBurned, 0)),
        waterMl: waters.filter((row) => row.loggedDate === date).reduce((sum, row) => sum + row.amountMl, 0),
        habitsDone: new Set(checked.filter((row) => row.loggedDate === date).map((row) => row.habitId)).size,
        habitsTotal: habitTotal,
      });
    }

    const loggedDays = days.filter((day) => day.intakeKcal > 0);
    const weightChangeKg =
      weights.length >= 2 ? this.round2(weights[weights.length - 1]!.weightKg - weights[0]!.weightKg) : null;

    return {
      from,
      to,
      days,
      avgIntakeKcal: this.round1(loggedDays.reduce((sum, day) => sum + day.intakeKcal, 0) / (loggedDays.length || 1)),
      totalExerciseKcal: this.round1(days.reduce((sum, day) => sum + day.exerciseKcal, 0)),
      weightChangeKg,
      micronutrients: DRI_REFERENCES.map((reference) => ({
        key: reference.key,
        name: reference.name,
        unit: reference.unit,
        dailyAvg: this.round2(this.sumMicronutrient(micronutrientRows, reference.key) / 7),
        reference: reference.reference,
        direction: reference.direction,
      })),
      referenceNote: '微量营养素参考值默认采用《中国居民膳食营养素参考摄入量》成人一般人群口径；公式与数据来源见「参考来源」页。',
    };
  }

  /** 微量营养素：按 `grams/100` 折算食物条目的每 100g 营养素并汇总（快速加卡无微量数据，跳过）。 */
  private async micronutrientRows(
    userId: number,
    from: string,
    to: string,
  ): Promise<Array<Record<MicronutrientKey, number>>> {
    const rows = await this.prisma.mealLog.findMany({
      where: { userId, loggedDate: { gte: from, lte: to }, foodItemId: { not: null } },
      include: {
        foodItem: {
          select: {
            fiberGPer100g: true,
            sodiumMgPer100g: true,
            sugarGPer100g: true,
            saturatedFatGPer100g: true,
            calciumMgPer100g: true,
            ironMgPer100g: true,
            potassiumMgPer100g: true,
            vitaminDUgPer100g: true,
            b12UgPer100g: true,
            magnesiumMgPer100g: true,
          },
        },
      },
    });

    return rows.map((row) => {
      const factor = (row.grams ?? 0) / 100;
      const food = row.foodItem;
      const value = (per100g: number | null): number => (food ? (per100g ?? 0) * factor : 0);
      return {
        fiberG: value(food?.fiberGPer100g ?? null),
        sodiumMg: value(food?.sodiumMgPer100g ?? null),
        sugarG: value(food?.sugarGPer100g ?? null),
        saturatedFatG: value(food?.saturatedFatGPer100g ?? null),
        calciumMg: value(food?.calciumMgPer100g ?? null),
        ironMg: value(food?.ironMgPer100g ?? null),
        potassiumMg: value(food?.potassiumMgPer100g ?? null),
        vitaminDUg: value(food?.vitaminDUgPer100g ?? null),
        b12Ug: value(food?.b12UgPer100g ?? null),
        magnesiumMg: value(food?.magnesiumMgPer100g ?? null),
      };
    });
  }

  private sumMicronutrient(rows: Array<Record<MicronutrientKey, number>>, key: MicronutrientKey): number {
    return rows.reduce((sum, row) => sum + row[key], 0);
  }

  private round1(value: number): number {
    return Math.round(value * 10) / 10;
  }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
