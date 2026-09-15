import { Injectable, Logger } from '@nestjs/common';

import { EXPORT_APP_ID, EXPORT_SCHEMA_VERSION, type ExportJsonPayload } from '@qsh/shared-types';
import { parseWeightCsv } from '@qsh/core';

import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { PrismaService } from '../prisma/prisma.service';

/** 体重导入行（§9.3）。 */
export interface WeightImportRow {
  date: string;
  weightKg: number;
  note?: string;
}

/** 导入结果（R10.2：同日覆盖，非法行汇总）。 */
export interface ImportResult {
  imported: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
}

/**
 * 数据主权服务（R10.1~R10.4，二期）：
 * 一键导出 / 导入 / **账号硬删除**。
 */
@Injectable()
export class DataService {
  private readonly logger = new Logger(DataService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 组装导出 JSON（字段名与 PRD §9.1 逐字一致，由 `@qsh/shared-types` 约束）。 */
  async exportAll(userId: number): Promise<ExportJsonPayload> {
    const [profile, goal, settings, weights, meals, exercises, habits, waters] = await Promise.all([
      this.prisma.userProfile.findUnique({ where: { userId } }),
      this.prisma.userGoal.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.userSettings.findUnique({ where: { userId } }),
      this.prisma.weightLog.findMany({ where: { userId }, orderBy: { loggedAt: 'asc' } }),
      this.prisma.mealLog.findMany({
        where: { userId },
        orderBy: [{ loggedDate: 'asc' }, { sortOrder: 'asc' }],
        include: { foodItem: { select: { name: true } } },
      }),
      this.prisma.exerciseLog.findMany({ where: { userId }, orderBy: { loggedDate: 'asc' } }),
      this.prisma.habitCheckin.findMany({
        where: { userId },
        orderBy: [{ loggedDate: 'asc' }, { id: 'asc' }],
        include: { habit: { select: { code: true } } },
      }),
      this.prisma.waterLog.findMany({ where: { userId }, orderBy: { loggedDate: 'asc' } }),
    ]);

    const mealsByDay = new Map<string, ExportJsonPayload['meals'][number]>();
    for (const meal of meals) {
      const bucket = mealsByDay.get(`${meal.loggedDate}|${meal.mealType}`) ?? {
        date: meal.loggedDate,
        mealType: meal.mealType as 'breakfast' | 'lunch' | 'dinner' | 'snack',
        items: [],
      };
      bucket.items.push({
        name: meal.foodItem?.name ?? meal.customName ?? '未命名条目',
        grams: Math.round((meal.grams ?? 0) * 10) / 10,
        kcal: Math.round(meal.kcal * 10) / 10,
        proteinG: Math.round((meal.proteinG ?? 0) * 10) / 10,
        fatG: Math.round((meal.fatG ?? 0) * 10) / 10,
        carbG: Math.round((meal.carbG ?? 0) * 10) / 10,
      });
      mealsByDay.set(`${meal.loggedDate}|${meal.mealType}`, bucket);
    }

    return {
      meta: {
        app: EXPORT_APP_ID,
        schemaVersion: EXPORT_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
      },
      profile: {
        gender: (profile?.gender ?? 'female') as 'male' | 'female',
        birthDate: profile?.birthDate ?? '1990-01-01',
        heightCm: profile?.heightCm ?? 165,
        activityLevel: (profile?.activityLevel ?? 'sedentary') as 'sedentary' | 'light' | 'moderate' | 'high' | 'athlete',
        dietaryPreference: this.parseJsonArray(profile?.dietaryPreference),
        conditions: this.parseJsonArray(profile?.conditions),
      },
      goals: {
        targetWeightKg: goal?.targetWeightKg ?? 55,
        targetWeeks: goal?.targetWeeks ?? 12,
        macroRatio: this.parseMacroRatio(goal?.macroRatio),
      },
      weights: weights.map((weight) => ({
        date: weight.loggedAt,
        weightKg: weight.weightKg,
        note: weight.note ?? '',
      })),
      meals: [...mealsByDay.values()],
      exercises: exercises.map((exercise) => ({
        date: exercise.loggedDate,
        type: exercise.activityCode,
        met: exercise.met,
        minutes: exercise.minutes,
        kcalBurned: Math.round(exercise.kcalBurned * 10) / 10,
      })),
      habits: habits.map((checkin) => ({
        date: checkin.loggedDate,
        habitId: checkin.habit.code,
        done: checkin.done,
      })),
      water: waters.map((water) => ({ date: water.loggedDate, ml: water.amountMl })),
      settings: {
        unit: (settings?.unit ?? 'kcal') === 'kj' ? ('kj' as const) : ('kcal' as const),
        darkMode: settings?.darkMode ?? false,
        fastingEnabled: settings?.fastingEnabled ?? false,
      },
    };
  }

  /**
   * 导入历史体重（§9.3）：同日覆盖；支持客户端已解析的 `rows` 或原始 `csvText`。
   * 非法行跳过并汇总，不影响合法行。
   */
  async importWeights(userId: number, payload: { rows?: WeightImportRow[]; csvText?: string }): Promise<ImportResult> {
    let rows: WeightImportRow[] = [];
    let errors: Array<{ row: number; reason: string }> = [];

    if (typeof payload.csvText === 'string' && payload.csvText.trim().length > 0) {
      const parsed = parseWeightCsv(payload.csvText);
      rows = parsed.rows;
      errors = parsed.errors;
    } else if (Array.isArray(payload.rows)) {
      rows = payload.rows.filter((row) => this.isValidRow(row));
      const invalid = payload.rows.filter((row) => !this.isValidRow(row));
      errors = invalid.map((row, index) => ({ row: index + 2, reason: `行数据无效（${JSON.stringify(row)}）` }));
    } else {
      throw new ApiException(400, ERROR_CODES.VALID_IMPORT_EMPTY, '请提供要导入的体重数据');
    }

    // 单事务批量写入（此前逐行往返，500 行导入要 500 次串行查询）
    await this.prisma.$transaction(
      rows.map((row) =>
        this.prisma.weightLog.upsert({
          where: { userId_loggedAt: { userId, loggedAt: row.date } },
          create: {
            userId,
            loggedAt: row.date,
            weightKg: row.weightKg,
            note: row.note ?? null,
            source: 'import',
          },
          update: { weightKg: row.weightKg, note: row.note ?? null, source: 'import' },
        }),
      ),
    );

    return { imported: rows.length, skipped: errors.length, errors };
  }

  /**
   * **账号硬删除**（R10.4 / K9 / TC-41）：删除 `users` 行，全表级联清除。
   * 这是唯一会删除数据的入口；不提供软删除。
   */
  async deleteAccount(userId: number): Promise<{ deleted: true }> {
    this.logger.log(`硬删除用户数据：userId=${userId}`);
    await this.prisma.user.delete({ where: { id: userId } });
    return { deleted: true };
  }

  private isValidRow(row: WeightImportRow): boolean {
    return (
      typeof row?.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
      Number.isFinite(row?.weightKg) &&
      row.weightKg > 0 &&
      row.weightKg < 500
    );
  }

  /** 解析档案里的 JSON 字符串数组（空/坏值返回空数组，不抛错）。 */
  private parseJsonArray(raw: string | null | undefined): string[] {
    if (!raw) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  /** 解析 `user_goals.macro_ratio`（JSON `{protein,fat,carb}`，坏值回退默认 25/25/50）。 */
  private parseMacroRatio(raw: string | null | undefined): { protein: number; fat: number; carb: number } {
    const fallback = { protein: 25, fat: 25, carb: 50 };
    if (!raw) {
      return fallback;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const value = parsed as Record<string, unknown>;
        const protein = Number(value.protein);
        const fat = Number(value.fat);
        const carb = Number(value.carb);
        if ([protein, fat, carb].every((item) => Number.isFinite(item) && item >= 0)) {
          return { protein, fat, carb };
        }
      }
      return fallback;
    } catch {
      return fallback;
    }
  }
}
