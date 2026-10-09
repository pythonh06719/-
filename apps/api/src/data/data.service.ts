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
import { WEIGHT_IMPORT_BATCH_SIZE } from './weight-import.constants';

/** 体重导入行（§9.3）。 */
export interface WeightImportRow {
  date: string;
  weightKg: number;
  note?: string;
}

/** 导入前某一天的体重旧值快照（失败回滚时写回，见 `restoreWeightSnapshot`）。 */
export interface WeightImportSnapshotRow {
  loggedAt: string;
  weightKg: number;
  note: string | null;
  source: string;
}

/**
 * 按固定大小切分数组（**不修改入参**；`size <= 0` 时按整块返回，避免死循环）。
 *
 * 用途有二：① 把 N 条 upsert 切成多个事务（体重导入分批，见
 * `writeWeightRowsInBatches`）；② 把 2000 个日期切成多段 `IN` 查询，
 * 不赌 SQLite 的绑定变量上限。
 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    return [[...items]];
  }
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
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
        // （默认值 2000 与 `water.service.ts` 的 `?? 2000`、DDL `@default(2000)` 一致，
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
     * **分批**事务写入（此前逐行往返，500 行导入要 500 次串行查询）。
     *
     * ⚠️ `$transaction` 收 `[]` 时**没有实际事务被开启**，是空操作 —— 所以这里显式判空，
     * 避免「0 行也要开一次事务」的误导性写法；返回值照旧是 `imported: 0`。
     *
     * ⚠️⚠️ **为什么必须分批**（规模缺陷，只在行数多时暴露）：这里曾经是
     * `await this.prisma.$transaction(rows.map(...))` —— **一条**事务包住全部 N 条 upsert。
     * 数据库是 SQLite（单写者），N 条写在一个事务里会**长期独占写锁**，
     * 而 Prisma 事务默认 5 秒超时（`P2028`）：2000 行（= `MAX_IMPORT_ROWS` 上限，
     * 约 5 年逐日记录）几乎必然超时，结果是**整批回滚、一行都没进去**，
     * 用户只看到一次失败。2000 行在自用场景完全可能，而这条接口正是为它写的。
     *
     * 现在按 {@link WEIGHT_IMPORT_BATCH_SIZE}（500）切片，每片一个独立事务，
     * 单事务写锁持有时间降到百毫秒级，不再触碰 5 秒上限。
     */
    if (rows.length > 0) {
      await this.writeWeightRowsInBatches(userId, rows);
    }

    return { imported: rows.length, skipped: errors.length, errors };
  }

  /**
   * 把 N 条体重 upsert **按批切成多个事务**顺序执行（详见调用处的缺陷说明）。
   *
   * ### ⚠️ 分批绝不能破坏「同日覆盖、后者胜」
   *
   * upsert 的唯一键是 `@@unique([userId, loggedAt])`，所以「后者胜」**完全取决于
   * 执行顺序**：同一日期的两条记录若被切到不同批次，仍必须是**后一条**覆盖前一条。
   * 这里用 `for` + `await` 按 `rows` 原序（下标升序）**串行**提交每一批 ——
   * 没有 `Promise.all`、没有并发 —— 因此跨批执行顺序与不分批时逐条执行**完全一致**，
   * 语义不变（`apps/api/test/weight-import-batch.e2e.test.ts` 有用例钉住：
   * 同一日期的第 1 行与最后一行分属首尾两批，断言库里是最后一条的值）。
   *
   * ### 中途某批失败怎么办 → **选 (a)：整批失败，回滚到导入前**
   *
   * 两个选项：(a) 全或无 —— 已写入的批也要撤掉，用户看到一次失败、库里没有半成品；
   * (b) 部分成功 —— 已成功的批保留，返回 `imported` 为实际写入数。
   *
   * **选 (a)**，理由（产品决定）：
   * ① **导入结果必须与用户看到的 `imported` 数一致** —— 这条比「尽量多导」重要。
   *    (b) 需要前端有「部分成功」的展示位（「导入了 1373 行，剩下 627 行没进去」），
   *    而当前前端只有「成功 / 失败」两种提示，没有这个位；给了 `imported: 1373`
   *    用户只会以为 2000 行都进去了，下次再导一次又会撞上同样的失败。
   * ② 体重是**趋势图与移动平均的输入**：半成品数据（前 1373 天有、后 627 天没有）
   *    会让 7 日均线、周报体重变化量算出**看起来正常但实际错误**的结果，
   *    比「看得见的一次失败」更难发现。
   * ③ 不分批时的既有语义就是全或无（单事务回滚），(a) 与它**逐字一致**，
   *    分批只是性能改造，不该顺手改掉失败语义。
   *
   * 实现上：分批后没有「一个包住全部的外层事务」（那正是要避免的长事务），
   * 所以 (a) 的回滚靠**补偿事务** —— 写入前先把受影响日期的旧值快照下来
   * （{@link snapshotWeightRows}），任一批失败就在一个事务里删掉这些日期的行、
   * 再把快照写回（{@link restoreWeightSnapshot}）。补偿本身失败只记日志，
   * 仍把**原始错误**抛给上层（不让它掩盖真正的失败原因）。
   */
  private async writeWeightRowsInBatches(userId: number, rows: WeightImportRow[]): Promise<void> {
    const dates = this.uniqueDates(rows);
    const snapshot = await this.snapshotWeightRows(userId, dates);

    try {
      for (let start = 0; start < rows.length; start += WEIGHT_IMPORT_BATCH_SIZE) {
        const batch = rows.slice(start, start + WEIGHT_IMPORT_BATCH_SIZE);
        await this.prisma.$transaction(
          batch.map((row) => this.buildWeightImportUpsert(userId, row)),
        );
      }
    } catch (error) {
      await this.restoreWeightSnapshot(userId, dates, snapshot);
      throw error;
    }
  }

  /** 一行体重的 upsert 语句（不 await —— 交给 `$transaction` 批量提交）。 */
  private buildWeightImportUpsert(userId: number, row: WeightImportRow) {
    return this.prisma.weightLog.upsert({
      where: { userId_loggedAt: { userId, loggedAt: row.date } },
      create: {
        userId,
        loggedAt: row.date,
        weightKg: row.weightKg,
        note: row.note ?? null,
        source: 'import',
      },
      update: { weightKg: row.weightKg, note: row.note ?? null, source: 'import' },
    });
  }

  /**
   * 导入前快照：读出**这次会碰到的日期**上已有的体重行，用于失败时回滚。
   *
   * 按 {@link WEIGHT_IMPORT_BATCH_SIZE} 切分 `IN` 查询，避免一次把 2000 个日期
   * 塞进单条 SQL（SQLite 的绑定变量上限随版本变化，不赌它）。
   *
   * ### 代价（明确接受，并与本文件既有取舍不冲突）
   *
   * 每次导入会多 1~N 次只读查询（走 `ix_weight_user_at` 索引；2000 行全量导入
   * 实测 ~800ms 含写，可忽略）。这与 {@link ImportResult} 注释里「不为 `overwritten`
   * 多跑一轮查询」的取舍**不冲突**：那个数字是**用户读不懂也提不出需求**的，
   * 而这里换来的是「失败时能安全回滚」—— 正确性问题的优先级高于一次往返。
   */
  private async snapshotWeightRows(
    userId: number,
    dates: string[],
  ): Promise<WeightImportSnapshotRow[]> {
    if (dates.length === 0) {
      return [];
    }

    const snapshot: WeightImportSnapshotRow[] = [];
    for (const part of chunk(dates, WEIGHT_IMPORT_BATCH_SIZE)) {
      const found = await this.prisma.weightLog.findMany({
        where: { userId, loggedAt: { in: part } },
        select: { loggedAt: true, weightKg: true, note: true, source: true },
      });
      snapshot.push(...found);
    }
    return snapshot;
  }

  /**
   * 补偿事务：删掉本次导入涉及日期的全部体重行，再把快照写回。
   *
   * 之所以能「全删再写回」：**这些日期上此刻的每一行都是本次导入写的**
   * （要么是我们新建的，要么是被我们 upsert 覆盖的），而快照里是导入**前**的旧值 ——
   * 于是「全删 + 写回快照」恰好把数据恢复到导入前的状态。
   *
   * ⚠️ 代价（明确接受）：`createMany` 是新增行，`id` / `createdAt` 不保证与原来相同
   * —— 恢复的是**内容等价**状态。体重记录没有其它表引用它的 `id`，故可接受。
   *
   * @param dates 本次导入涉及的去重日期
   * @param snapshot 导入前这些日期上的旧值（可能为空数组）
   */
  private async restoreWeightSnapshot(
    userId: number,
    dates: string[],
    snapshot: WeightImportSnapshotRow[],
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        for (const part of chunk(dates, WEIGHT_IMPORT_BATCH_SIZE)) {
          await tx.weightLog.deleteMany({ where: { userId, loggedAt: { in: part } } });
        }
        if (snapshot.length > 0) {
          await tx.weightLog.createMany({
            data: snapshot.map((row) => ({
              userId,
              loggedAt: row.loggedAt,
              weightKg: row.weightKg,
              note: row.note,
              source: row.source,
            })),
          });
        }
      });
    } catch (compensationError) {
      // 补偿失败也不能吞掉原始错误：只记日志，让调用方照常把真正的失败原因抛上去。
      this.logger.error(
        `体重导入回滚失败（userId=${userId}，${dates.length} 个日期）：${
          compensationError instanceof Error ? compensationError.message : String(compensationError)
        }`,
      );
    }
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
