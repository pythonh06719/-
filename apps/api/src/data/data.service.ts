import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import {
  EXPORT_APP_ID,
  EXPORT_SCHEMA_VERSION,
  type DataOverviewResponse,
  type ExportJsonPayload,
  type RecordOverviewKey,
  type RecordOverviewRow,
  type RestorePreviewResponse,
  type RestoreResult,
} from '@qsh/shared-types';
import {
  DEFAULT_WATER_GOAL_ML,
  deriveWeeklyLossKg,
  parseExportPayload,
  parseWeightCsv,
  type ExportPayloadSummary,
  type ParsedExportPayload,
} from '@qsh/core';

import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { isValidLocalDateKey, toDateKey } from '../common/utils/date.util';
import { PrismaService } from '../prisma/prisma.service';

/** 体重导入行（§9.3）。 */
export interface WeightImportRow {
  date: string;
  weightKg: number;
  note?: string;
}

/**
 * 导入结果（R10.2：同日覆盖，非法行汇总）。
 *
 * ### 与 `@qsh/shared-types` 里 `CsvImportResult` 的关系（GAP-6 的判断）
 *
 * `CsvImportResult`（`packages/shared-types/src/export.ts`）定义了
 * `{ imported, overwritten, skipped, errors }` —— 和这里只差一个 `overwritten`。
 * **刻意不合并**：
 *
 * - `overwritten` 不是「多一个字段」这么简单。要在**单事务批量 upsert** 里数出
 *   「本次覆盖了几条」，只能先 `findMany` 一次已知日期再 upsert —— 500 行导入要
 *   多一次往返，而这整条路径的存在理由就是**砍掉往返**（注释见 `importWeights`）。
 * - 更重要的是：`overwritten` 是**用户读不懂也提不出需求**的数字。
 *   「同日期以导入值覆盖」已经在页面上写清楚了，再报一句「覆盖了 3 条」只会让人
 *   回头去比对到底是哪 3 条 —— 与 NFR-11「每个数字都要可解释」的方向相反。
 * - 契约也并未被违反：`ImportResult` 只是 `CsvImportResult` 的**结构子集**，
 *   前端按 `CsvImportResult` 收窄读取是安全的；反过来前端若真要用 `overwritten`，
 *   现有 UI 也没有任何位置展示它（零引用），所以**不动契约**是正确取舍。
 *
 * ⚠️ 若将来真要做「覆盖数」，正确做法是让前端在导入前用
 * `listQueuedRequests` 同源的本地记录算差集，而不是让服务端为这个数字多跑一轮查询。
 */
export interface ImportResult {
  imported: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
}

/** 恢复预览在服务端的短期状态；只保留已通过 core 校验的结构。 */
interface PendingRestore {
  userId: number;
  payload: ParsedExportPayload;
  summary: ExportPayloadSummary;
  expiresAt: number;
  inUse: boolean;
}

/** 预览凭据有效期：给用户留足确认时间，同时限制内存驻留。 */
const RESTORE_PREVIEW_TTL_MS = 15 * 60 * 1000;

/**
 * 数据主权服务（R10.1~R10.4，二期）：
 * 一键导出 / 导入 / **账号硬删除**。
 */
@Injectable()
export class DataService {
  private readonly logger = new Logger(DataService.name);
  private readonly pendingRestores = new Map<string, PendingRestore>();

  constructor(private readonly prisma: PrismaService) {}

  /** 组装导出 JSON（字段名与 PRD §9.1 逐字一致，由 `@qsh/shared-types` 约束）。 */
  async exportAll(userId: number): Promise<ExportJsonPayload> {
    const [profile, goal, settings, weights, meals, exercises, habits, waters, wins] = await Promise.all([
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
      // R11.4：`wins` 作为独立顶层键导出（schemaVersion 2）；与其他实体无外键，不联表（§6.6）
      this.prisma.winLog.findMany({
        where: { userId },
        orderBy: [{ loggedDate: 'asc' }, { id: 'asc' }],
      }),
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
      wins: wins.map((win) => ({ date: win.loggedDate, text: win.text })),
      settings: {
        unit: (settings?.unit ?? 'kcal') === 'kj' ? ('kj' as const) : ('kcal' as const),
        // D-3：体重展示单位随备份导出（存储口径仍是 kg，这里只带「偏好」）
        weightUnit: (settings?.weightUnit ?? 'kg') === 'jin' ? ('jin' as const) : ('kg' as const),
        darkMode: settings?.darkMode ?? false,
        fastingEnabled: settings?.fastingEnabled ?? false,
        // GAP-3：每日饮水目标随备份导出，使「设置可完整恢复」对饮水目标也成立
        // （默认值与 core `DEFAULT_WATER_GOAL_ML`、DDL `@default(2000)` 一致，
        //   常量取自 core，避免在多处各写一个字面量）
        waterGoalMl: settings?.waterGoalMl ?? DEFAULT_WATER_GOAL_ML,
      },
    };
  }

  /**
   * **记录概览**（R11.6 / AC-11.6.6）：各类记录的**条数与最早/最晚日期**。
   *
   * 只陈述事实，**不做任何离群值 / 异常值判定**（AC-11.6.7 硬约束，本轮禁止实现）——
   * 「异常」本身就是一种评判，且定义阈值会变成用户看不见的隐性标准，
   * 与「每个数字都可解释」（NFR-11）相冲突。
   *
   * 6 个 `aggregate` 并发下推给 SQLite，**不把任何原始行拉进内存**（K15，Q-8 不缓存）。
   *
   * ⚠️ `wins` 行自 R11.4（四期）起为**真实计数**（Q-6 预留位的兑现）：
   * R11.4 上线前恒为 0 / 前端整行隐藏，上线后自动出现 —— 前端 `DataOverviewCard` 零改动。
   */
  async overview(userId: number): Promise<DataOverviewResponse> {
    const [weights, meals, exercises, habits, water, wins] = await Promise.all([
      this.prisma.weightLog.aggregate({
        where: { userId },
        _count: { _all: true },
        _min: { loggedAt: true },
        _max: { loggedAt: true },
      }),
      this.prisma.mealLog.aggregate({
        where: { userId },
        _count: { _all: true },
        _min: { loggedDate: true },
        _max: { loggedDate: true },
      }),
      this.prisma.exerciseLog.aggregate({
        where: { userId },
        _count: { _all: true },
        _min: { loggedDate: true },
        _max: { loggedDate: true },
      }),
      // 习惯打卡：`done` 真假都算 —— 只要记过就算一条（口径：行数）
      this.prisma.habitCheckin.aggregate({
        where: { userId },
        _count: { _all: true },
        _min: { loggedDate: true },
        _max: { loggedDate: true },
      }),
      this.prisma.waterLog.aggregate({
        where: { userId },
        _count: { _all: true },
        _min: { loggedDate: true },
        _max: { loggedDate: true },
      }),
      this.prisma.winLog.aggregate({
        where: { userId },
        _count: { _all: true },
        _min: { loggedDate: true },
        _max: { loggedDate: true },
      }),
    ]);

    const rows: RecordOverviewRow[] = [
      this.toRow('weights', weights._count._all, weights._min.loggedAt, weights._max.loggedAt),
      this.toRow('meals', meals._count._all, meals._min.loggedDate, meals._max.loggedDate),
      this.toRow('exercises', exercises._count._all, exercises._min.loggedDate, exercises._max.loggedDate),
      this.toRow('habits', habits._count._all, habits._min.loggedDate, habits._max.loggedDate),
      this.toRow('water', water._count._all, water._min.loggedDate, water._max.loggedDate),
      // R11.4：真实计数；`win_logs.logged_date` 本就是 `YYYY-MM-DD` 文本
      this.toRow('wins', wins._count._all, wins._min.loggedDate, wins._max.loggedDate),
    ];

    return { rows };
  }

  /**
   * 组装一行概览（日期统一归一为 `YYYY-MM-DD`，缺失为 `null`）。
   *
   * ⚠️ `firstDate/lastDate` 同时接受 `string | Date`：SQLite 下 `logged_at` 是 `String`，
   * 迁移到 PG 的 `DateTime @db.Date` 后 Prisma 返回 `Date` —— 统一走 `toDateKey` 归一，
   * 避免直接 `.slice` 在 `Date` 上崩溃（#7 / PG 兼容）。
   */
  private toRow(
    key: RecordOverviewKey,
    count: number,
    firstDate: string | Date | null,
    lastDate: string | Date | null,
  ): RecordOverviewRow {
    return {
      key,
      count,
      firstDate: firstDate === null ? null : toDateKey(firstDate),
      lastDate: lastDate === null ? null : toDateKey(lastDate),
    };
  }

  /**
   * 读取并预览 JSON 备份。这里只建立短期的一次性凭据，不写数据库。
   * 解析、版本兼容、字段校验与统计全部由 `@qsh/core` 的纯函数完成。
   */
  previewRestore(userId: number, request: { content?: unknown }): RestorePreviewResponse {
    const parsed = parseExportPayload(request?.content);
    if (!parsed.ok) {
      throw new ApiException(400, ERROR_CODES.VALID_RESTORE_PAYLOAD, parsed.error.message);
    }

    this.removeExpiredRestorePreviews();
    for (const [token, pending] of this.pendingRestores.entries()) {
      if (pending.userId === userId) {
        this.pendingRestores.delete(token);
      }
    }

    const previewToken = randomUUID();
    this.pendingRestores.set(previewToken, {
      userId,
      payload: parsed.payload,
      summary: parsed.summary,
      expiresAt: Date.now() + RESTORE_PREVIEW_TTL_MS,
      inUse: false,
    });

    return {
      previewToken,
      schemaVersion: parsed.payload.meta.schemaVersion,
      counts: parsed.summary.counts,
      dateRange: parsed.summary.dateRange,
      mergeStrategy: 'same-day-replace',
    };
  }

  /**
   * 确认恢复：备份里出现的实体日期整日替换，未出现的日期保留；档案、目标与设置采用备份值。
   * 所有删除和写入都在一个 Prisma 交互式事务里完成，任一步未完成都会整体回滚。
   */
  async restore(userId: number, request: { previewToken?: unknown }): Promise<RestoreResult> {
    this.removeExpiredRestorePreviews();
    const previewToken = typeof request?.previewToken === 'string' ? request.previewToken : '';
    const pending = this.pendingRestores.get(previewToken);
    if (pending === undefined || pending.userId !== userId || pending.inUse) {
      throw new ApiException(
        404,
        ERROR_CODES.NOTFOUND_RESTORE_PREVIEW,
        '没有找到这份恢复预览，请重新选择备份文件',
      );
    }

    pending.inUse = true;
    const { payload, summary } = pending;
    const nowIso = new Date().toISOString();

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.userProfile.upsert({
          where: { userId },
          create: {
            userId,
            gender: payload.profile.gender,
            birthDate: payload.profile.birthDate,
            heightCm: payload.profile.heightCm,
            activityLevel: payload.profile.activityLevel,
            dietaryPreference: JSON.stringify(payload.profile.dietaryPreference),
            conditions: JSON.stringify(payload.profile.conditions),
          },
          update: {
            gender: payload.profile.gender,
            birthDate: payload.profile.birthDate,
            heightCm: payload.profile.heightCm,
            activityLevel: payload.profile.activityLevel,
            dietaryPreference: JSON.stringify(payload.profile.dietaryPreference),
            conditions: JSON.stringify(payload.profile.conditions),
            updatedAt: nowIso,
          },
        });

        const existingGoal = await tx.userGoal.findUnique({ where: { userId } });
        const latestBackupWeight = [...payload.weights].sort((a, b) => b.date.localeCompare(a.date))[0]?.weightKg;
        const startWeightKg = existingGoal?.startWeightKg ?? latestBackupWeight ?? payload.goals.targetWeightKg;
        const weeklyLossKg = deriveWeeklyLossKg(
          startWeightKg,
          payload.goals.targetWeightKg,
          payload.goals.targetWeeks,
        );
        await tx.userGoal.upsert({
          where: { userId },
          create: {
            userId,
            startWeightKg,
            targetWeightKg: payload.goals.targetWeightKg,
            targetWeeks: payload.goals.targetWeeks,
            weeklyLossKg,
            macroRatio: JSON.stringify(payload.goals.macroRatio),
          },
          update: {
            targetWeightKg: payload.goals.targetWeightKg,
            targetWeeks: payload.goals.targetWeeks,
            weeklyLossKg,
            macroRatio: JSON.stringify(payload.goals.macroRatio),
            updatedAt: nowIso,
          },
        });

        await tx.userSettings.upsert({
          where: { userId },
          create: {
            userId,
            unit: payload.settings.unit,
            // D-3：恢复备份时把体重展示单位一并还原（core 解析层对旧备份缺省为 kg）
            weightUnit: payload.settings.weightUnit,
            darkMode: payload.settings.darkMode,
            fastingEnabled: payload.settings.fastingEnabled,
            // GAP-3：饮水目标一并还原（core 解析层对旧备份缺省为默认 2000）
            waterGoalMl: payload.settings.waterGoalMl,
          },
          update: {
            unit: payload.settings.unit,
            weightUnit: payload.settings.weightUnit,
            darkMode: payload.settings.darkMode,
            fastingEnabled: payload.settings.fastingEnabled,
            // GAP-3：饮水目标一并还原
            waterGoalMl: payload.settings.waterGoalMl,
            updatedAt: nowIso,
          },
        });

        const weightDates = this.uniqueDates(payload.weights);
        if (weightDates.length > 0) {
          await tx.weightLog.deleteMany({ where: { userId, loggedAt: { in: weightDates } } });
          await tx.weightLog.createMany({
            data: payload.weights.map((row) => ({
              userId,
              loggedAt: row.date,
              weightKg: row.weightKg,
              note: row.note === '' ? null : row.note,
              source: 'import',
            })),
          });
        }

        const mealDates = this.uniqueDates(payload.meals);
        if (mealDates.length > 0) {
          await tx.mealLog.deleteMany({ where: { userId, loggedDate: { in: mealDates } } });
          const nextSortOrder = new Map<string, number>();
          const mealRows = payload.meals.flatMap((meal) =>
            meal.items.map((item) => {
              const bucketKey = `${meal.date}|${meal.mealType}`;
              const sortOrder = nextSortOrder.get(bucketKey) ?? 0;
              nextSortOrder.set(bucketKey, sortOrder + 1);
              return {
                userId,
                loggedDate: meal.date,
                mealType: meal.mealType,
                customName: item.name,
                grams: item.grams,
                kcal: item.kcal,
                proteinG: item.proteinG,
                fatG: item.fatG,
                carbG: item.carbG,
                source: 'quick_add',
                sortOrder,
              };
            }),
          );
          if (mealRows.length > 0) {
            await tx.mealLog.createMany({ data: mealRows });
          }
        }

        const exerciseDates = this.uniqueDates(payload.exercises);
        if (exerciseDates.length > 0) {
          await tx.exerciseLog.deleteMany({ where: { userId, loggedDate: { in: exerciseDates } } });
          const exerciseRows = [];
          for (const row of payload.exercises) {
            const activity = await tx.metActivity.findUnique({ where: { code: row.type } });
            if (activity === null) {
              throw new ApiException(
                400,
                ERROR_CODES.VALID_RESTORE_PAYLOAD,
                '备份里有一项运动在当前版本中没有对应条目',
              );
            }
            const calculatedWeight = row.kcalBurned / (row.met * (row.minutes / 60));
            const weightKgAtLog =
              Number.isFinite(calculatedWeight) && calculatedWeight > 0 && calculatedWeight < 500
                ? calculatedWeight
                : (latestBackupWeight ?? startWeightKg);
            exerciseRows.push({
              userId,
              loggedDate: row.date,
              activityCode: activity.code,
              activityName: activity.name,
              met: row.met,
              minutes: row.minutes,
              weightKgAtLog,
              kcalBurned: row.kcalBurned,
            });
          }
          if (exerciseRows.length > 0) {
            await tx.exerciseLog.createMany({ data: exerciseRows });
          }
        }

        const habitDates = this.uniqueDates(payload.habits);
        if (habitDates.length > 0) {
          await tx.habitCheckin.deleteMany({ where: { userId, loggedDate: { in: habitDates } } });
          const habitIds = new Map<string, number>();
          for (const code of new Set(payload.habits.map((row) => row.habitId))) {
            const definition = await tx.habitDefinition.findFirst({
              where: { code, OR: [{ userId }, { userId: null }] },
              orderBy: [{ userId: 'desc' }, { id: 'asc' }],
            });
            const habitId =
              definition?.id ??
              (
                await tx.habitDefinition.create({
                  data: { userId, code, name: code },
                  select: { id: true },
                })
              ).id;
            habitIds.set(code, habitId);
          }
          await tx.habitCheckin.createMany({
            data: payload.habits.map((row) => ({
              userId,
              habitId: habitIds.get(row.habitId) as number,
              loggedDate: row.date,
              done: row.done,
            })),
          });
        }

        const waterDates = this.uniqueDates(payload.water);
        if (waterDates.length > 0) {
          await tx.waterLog.deleteMany({ where: { userId, loggedDate: { in: waterDates } } });
          await tx.waterLog.createMany({
            data: payload.water.map((row, index) => ({
              userId,
              loggedDate: row.date,
              loggedAt: `${row.date}T12:00:${String(index % 60).padStart(2, '0')}.000Z`,
              amountMl: row.ml,
            })),
          });
        }

        const winDates = this.uniqueDates(payload.wins);
        if (winDates.length > 0) {
          await tx.winLog.deleteMany({ where: { userId, loggedDate: { in: winDates } } });
          await tx.winLog.createMany({
            data: payload.wins.map((row) => ({ userId, loggedDate: row.date, text: row.text })),
          });
        }
      });
    } finally {
      this.pendingRestores.delete(previewToken);
    }

    return {
      restored: summary.counts,
      dateRange: summary.dateRange,
      mergeStrategy: 'same-day-replace',
    };
  }

  /** 返回记录中的去重日期，作为“有该日期才覆盖”的事务删除条件。 */
  private uniqueDates(rows: ReadonlyArray<{ date: string }>): string[] {
    return [...new Set(rows.map((row) => row.date))];
  }

  /** 惰性清理过期预览，避免用户选择文件后离开页面造成长期内存驻留。 */
  private removeExpiredRestorePreviews(): void {
    const now = Date.now();
    for (const [token, pending] of this.pendingRestores.entries()) {
      if (pending.expiresAt <= now) {
        this.pendingRestores.delete(token);
      }
    }
  }

  /**
   * 导入历史体重（§9.3）：同日覆盖；支持客户端已解析的 `rows` 或原始 `csvText`。
   * 非法行跳过并汇总，不影响合法行。
   *
   * **GAP-6**：本方法就是「批量接口」的服务端实现 —— 单事务批量 upsert，
   * 专为替代前端「逐行 POST `/weights`」而写（此前 500 行导入 = 500 次串行往返）。
   */
  async importWeights(
    userId: number,
    payload: { rows?: WeightImportRow[]; csvText?: string },
  ): Promise<ImportResult> {
    let rows: WeightImportRow[] = [];
    let errors: Array<{ row: number; reason: string }> = [];

    if (typeof payload.csvText === 'string' && payload.csvText.trim().length > 0) {
      const parsed = parseWeightCsv(payload.csvText);
      rows = parsed.rows;
      errors = parsed.errors;
    } else if (Array.isArray(payload.rows)) {
      /**
       * `rows` 分支：**保留合法行、把非法行计入 `skipped`**（不整批 400）——
       * 这是与 `csvText` 分支对齐的既有语义，也是「导入是尽力而为」的产品决定。
       *
       * ⚠️ 行号口径修正（GAP-6）：`csvText` 分支来自 `parseWeightCsv`，其行号是
       * **原文件真实行号**（含表头，数据首行 = 2）；`rows` 分支此前用
       * `invalid.map((row, index) => index + 2)`，这里的 `index` 是**过滤后数组**的序号，
       * 一行非法就会让后面所有行号整体前移（结果错误）。改为**一次遍历**同时收集
       * 合法行与带真实序号的错误，两个分支的行号口径才对得上。
       */
      const invalid: Array<{ row: number; reason: string }> = [];
      rows = [];
      payload.rows.forEach((row, index) => {
        if (this.isValidRow(row)) {
          rows.push(row);
        } else {
          // +2：`rows` 对应的是 CSV 数据行，首行数据在原文件里是第 2 行（第 1 行是表头）
          invalid.push({ row: index + 2, reason: `行数据无效（${JSON.stringify(row)}）` });
        }
      });
      errors = invalid;
    } else {
      throw new ApiException(400, ERROR_CODES.VALID_IMPORT_EMPTY, '请提供要导入的体重数据');
    }

    /**
     * 单事务批量写入（此前逐行往返，500 行导入要 500 次串行查询）。
     *
     * ⚠️ `$transaction` 收 `[]` 时**没有实际事务被开启**，是空操作 —— 所以这里显式判空，
     * 避免「0 行也要开一次事务」的误导性写法；返回值照旧是 `imported: 0`。
     */
    if (rows.length > 0) {
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
    }

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

  /**
   * 单行体重数据是否合法（`rows` 分支逐行过滤，坏行计入 `skipped`）。
   *
   * ⚠️ **日期判据必须与 `csvText` 分支一致**（GAP-6 的核心产品契约：
   * 「非法行跳过并汇总，不影响合法行」）。此前这里用**第三份裸正则**
   * `/^\d{4}-\d{2}-\d{2}$/`，只验形状不验真实性 —— `2026-02-31` 这类
   * **日历上不存在**的日期会被判为合法并 `upsert` 入库；而 `csvText` 分支走
   * core 的 `parseWeightCsv` → `isLocalDateKey`（严格 + 回环）会**拒绝**它。
   * 同一个接口的两条分支对同一份坏数据给出相反结论，且入库的那个不可逆
   * （会进入趋势图、污染移动平均、让周报体重变化量算错）。
   *
   * 现统一用 `isValidLocalDateKey`（`common/utils/date.util.ts`，口径唯一）：
   * - 与 core 的 `isLocalDateKey` 同一套「严格正则 + 回环比对」判据，两者结论一致；
   * - 与 `@IsLocalDateKey` 装饰器（DTO 层）同源，写接口与导入接口口径统一；
   * - 非法日期只是被**跳过并计入 `skipped`**，不抛错、不整批 400（契约不变）。
   *
   * 注：`isValidLocalDateKey` 是类型谓词（`value is string`），
   * 故不再需要原先的 `typeof row?.date === 'string'` —— 非字符串入参会被它一并拒绝。
   */
  private isValidRow(row: WeightImportRow): boolean {
    return (
      isValidLocalDateKey(row?.date) &&
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
