import { Injectable } from '@nestjs/common';

import type {
  MicronutrientSummary,
  PeriodDays,
  PeriodReport,
  ReportCalendarDay,
  ReportCalendarKind,
  ReportCalendarResponse,
  ReportDay,
  WeeklyReport,
} from '@qsh/shared-types';
import type { FoodRefRow } from '@qsh/core';
import { DISTINCT_FOOD_LIMIT, distinctFoodKeys, resolvePeriodWindow, summarizePeriod, type PeriodFacts } from '@qsh/core';

import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { addDays, monthDateRange, toDateKey, todayLocalKey } from '../common/utils/date.util';
import { FOOD_IDENTITY_PROJECTION_LIMIT, visibleFoodWhere } from '../foods/foods.util';
import { PrismaService } from '../prisma/prisma.service';

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

/**
 * 记录足迹日历的模块种类**固定顺序**（C-1）—— 与 `shared-types` 的
 * `ReportCalendarKind` 保持一致，保证 `kinds` 数组顺序可复现（便于前后端一致断言）。
 */
const CALENDAR_KIND_ORDER: readonly ReportCalendarKind[] = [
  'weight',
  'meal',
  'exercise',
  'habit',
  'water',
  'win',
];

/**
 * 周报 + 阶段回顾服务（二期 R4.1 / R11.1 · 四期 R11.3 / R11.7）。
 *
 * 全部聚合在服务端完成，前端只渲染。
 *
 * ⚠️ `WeeklyReport` / `ReportDay` / `MicronutrientSummary` **收敛到 `@qsh/shared-types`**（D-2）：
 * 本文件与 `ReportPage.tsx` 各持一份本地定义是 QA 指出的漂移风险，本轮扩展该类型前先收敛。
 *
 * ⚠️ 食物种类口径（K16）：R11.3 的「食物种类数」与 R11.7 的「N 种不同的食物」
 * **调用 `@qsh/core` 的同一个 `distinctFoodKeys`**，任何一侧不得自行实现去重。
 */
@Injectable()
export class ReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** 近 7 天（含 `endDate`）周报。 */
  async weekly(userId: number, endDate?: string): Promise<WeeklyReport> {
    const to = endDate ?? todayLocalKey();
    const from = addDays(to, -6);

    const [meals, exercises, waters, habits, weights, micronutrientRows, identityGroups] = await Promise.all([
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
      // R11.7：食物身份投影（与 `foods.top` / `period()` 同构的最小投影，D-1）
      this.foodIdentityGroups(userId, from, to),
    ]);

    const habitTotal = habits.length;
    /**
     * 🔴 **分子必须与分母同口径**：`habitTotal` 来自上面 `habits` 查询
     * （`where: { OR: [{ userId }, { userId: null }], isActive: true }`），
     * 即**只数「启用中」的习惯**。若 `checked` 不按同一集合过滤，
     * 叠加「停用只切 `isActive`、`HabitCheckin` 完全不动」这个刻意设计
     * （见 `HabitsService.setActive` 注释：停用而非删除，保住历史打卡）后，
     * 停用 1 个习惯就会得到 `habitsDone = 3 > habitsTotal = 2` —— 达成率 > 100%。
     *
     * 前端 `reportHabitRateLabel` 有 `Math.min(100, ...)` 夹取，所以**不会显示 130%**，
     * 但那等于把缺陷静默吞掉：用户看到的「达成率 100%」建立在口径不一致的数字上。
     *
     * 修法：`habit: { isActive: true }` 走 relation 过滤，与分母完全一致。
     * ⚠️ **只改 `weekly()`**：`period()` 的分子分母都用「含停用」的同一口径（那里查的是
     * 全量 `habitDefinition`），两者都正确，不要动。
     */
    const checked = await this.prisma.habitCheckin.findMany({
      where: {
        userId,
        loggedDate: { gte: from, lte: to },
        done: true,
        habit: { isActive: true },
      },
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
    /**
     * ★ 周报两处「日均」共用同一个分母（缺陷收尾 · 口径统一 + NFR-11）。
     *
     * 此前 `avgIntakeKcal` 除以「有记录的天数」、`micronutrients[].dailyAvg` 却固定除以 7 ——
     * 一周只记了 3 天饮食时，前者按 3 天算、后者按 7 天算，同一张卡上两个「日均」不同义，
     * 微量营养素会看起来约为真实值的 3/7（「几乎没吃什么」的错觉）。
     * 这里统一为「有记录的天数」（`|| 1` 兜底，避免整周无记录时除零），口径写进 `/why-numbers` ㉒。
     */
    const loggedDayCount = loggedDays.length || 1;
    const weightChangeKg =
      weights.length >= 2 ? this.round2(weights[weights.length - 1]!.weightKg - weights[0]!.weightKg) : null;

    // R11.7：种类口径交给 core 的唯一实现（库内条目与同名快加条目合并为 1 种，K16）
    const distinct = distinctFoodKeys(identityGroups.projection, { limit: DISTINCT_FOOD_LIMIT });

    return {
      from,
      to,
      days,
      avgIntakeKcal: this.round1(loggedDays.reduce((sum, day) => sum + day.intakeKcal, 0) / loggedDayCount),
      totalExerciseKcal: this.round1(days.reduce((sum, day) => sum + day.exerciseKcal, 0)),
      weightChangeKg,
      micronutrients: DRI_REFERENCES.map((reference) => {
        // 🔴 缺失（窗口内无记录 / 有记录但该项无数据）→ `dailyAvg: null`，前端显示「暂无数据」。
        // 绝不能兜成 0：那会让 5 项 `atMost` 恒判「达标 ✓」，把「没查到」报成「吃得很健康」。
        const sum = this.sumMicronutrient(micronutrientRows, reference.key);
        return {
          key: reference.key,
          name: reference.name,
          unit: reference.unit,
          dailyAvg: sum === null ? null : this.round2(sum / loggedDayCount),
          reference: reference.reference,
          direction: reference.direction,
        };
      }),
      referenceNote: '微量营养素参考值默认采用《中国居民膳食营养素参考摄入量》成人一般人群口径；公式与数据来源见「参考来源」页。',
      // ---- R11.7 向后兼容扩展（纯加字段，老客户端忽略未知字段，AC-11.7.6）----
      distinctFoodCount: distinct.count,
      distinctFoods: distinct.names,
      distinctFoodsTruncated: distinct.truncated,
    };
  }

  /**
   * 阶段回顾（R11.3 / AC-11.3.2 白名单 6 类指标）。
   *
   * - **聚合全部 SQL 下推**（K15 / AC-11.3.8）：10 个并发查询，每个都是
   *   `groupBy` / `aggregate` / `findFirst` 的最小投影，365 天档每个 ≤365 行；
   * - `days` 非 30 / 365 → 400（`resolvePeriodWindow` 返回 `null`，不允许隐式默认）；
   * - 指标归并交给 `@qsh/core` 的 `summarizePeriod`（口径唯一实现，本服务只做编排）。
   */
  async period(userId: number, days: PeriodDays, endDate?: string): Promise<PeriodReport> {
    const window = resolvePeriodWindow(days, endDate ?? null, todayLocalKey());
    if (window === null) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '阶段回顾只支持近 30 天或近 365 天', {
        days: '阶段回顾只支持近 30 天或近 365 天',
      });
    }
    const { from, to } = window;

    const [mealGroups, mealEntryCount, exerciseGroups, habitDateGroups, habitDoneGroups, habitDefs, weightFirst, weightLast, waterGroups, winGroups] =
      await Promise.all([
        // ① 食物身份投影（最小投影：(身份候选, 日期) 二元组，与 `foods.top` 同构）
        this.foodIdentityGroups(userId, from, to),
        // ② 餐次条目总数（行数口径）
        this.prisma.mealLog.count({ where: { userId, loggedDate: { gte: from, lte: to } } }),
        // ④ 运动聚合
        this.prisma.exerciseLog.groupBy({
          by: ['loggedDate'],
          where: { userId, loggedDate: { gte: from, lte: to } },
          _count: { _all: true },
          _sum: { minutes: true },
        }),
        // ⑤「有记录的天数」用：习惯打卡（含 done=false —— 记过就算，与 /data/overview 口径一致）
        this.prisma.habitCheckin.groupBy({
          by: ['loggedDate'],
          where: { userId, loggedDate: { gte: from, lte: to } },
        }),
        // 指标 ④ 候选：仅 done=true 计数
        this.prisma.habitCheckin.groupBy({
          by: ['habitId'],
          where: { userId, loggedDate: { gte: from, lte: to }, done: true },
          _count: { _all: true },
        }),
        // 指标 ④ 名称反查（系统内置 + 自建，一次取全，避免 N+1）
        this.prisma.habitDefinition.findMany({
          where: { OR: [{ userId }, { userId: null }] },
          select: { id: true, name: true },
        }),
        // 指标 ⑥ 体重首末条（两次轻查询，不拉全量 —— AC-11.3.4 取**有记录的**首末条）
        this.prisma.weightLog.findFirst({
          where: { userId, loggedAt: { gte: from, lte: to } },
          orderBy: { loggedAt: 'asc' },
          select: { id: true, loggedAt: true, weightKg: true },
        }),
        this.prisma.weightLog.findFirst({
          where: { userId, loggedAt: { gte: from, lte: to } },
          orderBy: { loggedAt: 'desc' },
          select: { id: true, loggedAt: true, weightKg: true },
        }),
        // ①「有记录的天数」用：饮水
        this.prisma.waterLog.groupBy({
          by: ['loggedDate'],
          where: { userId, loggedDate: { gte: from, lte: to } },
        }),
        // R11.4：win 条数 +「有记录的天数」并集
        this.prisma.winLog.groupBy({
          by: ['loggedDate'],
          where: { userId, loggedDate: { gte: from, lte: to } },
          _count: { _all: true },
        }),
      ]);

    const facts: PeriodFacts = {
      // 有记录的天数 = 各表日期键的并集（含体重首末日）
      loggedDates: [
        ...mealGroups.dates,
        ...exerciseGroups.map((row) => row.loggedDate),
        ...habitDateGroups.map((row) => row.loggedDate),
        ...waterGroups.map((row) => row.loggedDate),
        ...winGroups.map((row) => row.loggedDate),
        // ⚠️ 用 `toDateKey` 而非 `.slice(0, 10)`：PG 的 `DateTime @db.Date` 下 Prisma 返回
        // `Date`（UTC 00:00），对 Date 调 `.slice` 会崩溃（#7 / PG 兼容）。
        ...(weightFirst !== null ? [toDateKey(weightFirst.loggedAt)] : []),
        ...(weightLast !== null ? [toDateKey(weightLast.loggedAt)] : []),
      ],
      foodRows: mealGroups.projection,
      mealEntryCount,
      habitCounts: habitDoneGroups.map((row) => ({
        habitId: row.habitId,
        name: habitDefs.find((definition) => definition.id === row.habitId)?.name ?? '习惯',
        count: row._count._all,
      })),
      exercise: {
        sessions: exerciseGroups.reduce((sum, row) => sum + row._count._all, 0),
        totalMinutes: exerciseGroups.reduce((sum, row) => sum + (row._sum.minutes ?? 0), 0),
      },
      weightFirst:
        weightFirst === null
          ? null
          : { id: weightFirst.id, date: toDateKey(weightFirst.loggedAt), weightKg: weightFirst.weightKg },
      weightLast:
        weightLast === null
          ? null
          : { id: weightLast.id, date: toDateKey(weightLast.loggedAt), weightKg: weightLast.weightKg },
      winCount: winGroups.reduce((sum, row) => sum + row._count._all, 0),
    };

    const summary = summarizePeriod(facts, { from, to });
    return { ...summary, days };
  }

  /**
   * 记录足迹日历（C-1）：返回某月**有记录的日子 + 当天记了哪几类**（让前端算深浅）。
   *
   * - 只查**本人**（`userId` 取自 JWT）；
   * - 月份参数经 `monthDateRange` 校验（非法 → 400，不允许隐式默认）；
   * - 复用 meals / weights / water / habits / exercise / wins 的**日期聚合**（与 N2 一日档案、
   *   R11.6 记录概览同源数据），**零新表**、6 个并发只读查询，每个都 ≤ 当月行数；
   * - 习惯口径：`habitCheckin` 行存在即算「记过」（含 `done=false`，与 `period()` 的
   *   「有记录的天数」及 `/data/overview` 行数口径一致）；
   * - 响应**不含**任何分母 / 百分比 / 连续天数 —— 深浅由前端按 `kinds.length` 映射（NFR-11 ㉓）。
   */
  async calendar(userId: number, month: string): Promise<ReportCalendarResponse> {
    const range = monthDateRange(month);
    if (range === null) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '月份格式应为 YYYY-MM', {
        month: '月份格式应为 YYYY-MM',
      });
    }
    const { from, to } = range;

    const [meals, exercises, waters, habits, wins, weights] = await Promise.all([
      this.prisma.mealLog.groupBy({
        by: ['loggedDate'],
        where: { userId, loggedDate: { gte: from, lte: to } },
      }),
      this.prisma.exerciseLog.groupBy({
        by: ['loggedDate'],
        where: { userId, loggedDate: { gte: from, lte: to } },
      }),
      this.prisma.waterLog.groupBy({
        by: ['loggedDate'],
        where: { userId, loggedDate: { gte: from, lte: to } },
      }),
      this.prisma.habitCheckin.groupBy({
        by: ['loggedDate'],
        where: { userId, loggedDate: { gte: from, lte: to } },
      }),
      this.prisma.winLog.groupBy({
        by: ['loggedDate'],
        where: { userId, loggedDate: { gte: from, lte: to } },
      }),
      // 体重用 `loggedAt`（date-only 列）：`toDateKey` 兼容 SQLite 的 string 与 PG 的 Date
      this.prisma.weightLog.findMany({
        where: { userId, loggedAt: { gte: from, lte: to } },
        select: { loggedAt: true },
      }),
    ]);

    /** 日期 → 该日有记录的模块种类集合（Set 天然去重）。 */
    const kindsByDate = new Map<string, Set<ReportCalendarKind>>();
    const record = (kind: ReportCalendarKind, dateKey: string): void => {
      const bucket = kindsByDate.get(dateKey) ?? new Set<ReportCalendarKind>();
      bucket.add(kind);
      kindsByDate.set(dateKey, bucket);
    };

    for (const row of meals) record('meal', row.loggedDate);
    for (const row of exercises) record('exercise', row.loggedDate);
    for (const row of waters) record('water', row.loggedDate);
    for (const row of habits) record('habit', row.loggedDate);
    for (const row of wins) record('win', row.loggedDate);
    for (const row of weights) record('weight', toDateKey(row.loggedAt));

    const days: ReportCalendarDay[] = [...kindsByDate.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([date, kinds]) => ({ date, kinds: CALENDAR_KIND_ORDER.filter((kind) => kinds.has(kind)) }));

    return { month, from, to, days };
  }

  /**
   * 食物身份投影（R11.7 / R11.3 共用）：`groupBy` 最小投影 + 一次 `in` 反查显示名（避免 N+1，D-6）。
   * 与 `foods.service.top()` 是同一套已验证的模式。
   */
  private async foodIdentityGroups(
    userId: number,
    from: string,
    to: string,
  ): Promise<{ projection: FoodRefRow[]; dates: string[] }> {
    const grouped = await this.prisma.mealLog.groupBy({
      by: ['foodItemId', 'customName', 'loggedDate'],
      where: { userId, loggedDate: { gte: from, lte: to } },
      orderBy: [{ loggedDate: 'asc' }, { foodItemId: 'asc' }, { customName: 'asc' }],
      // 纵深防御上限（见 `FOOD_IDENTITY_PROJECTION_LIMIT` 注释）
      take: FOOD_IDENTITY_PROJECTION_LIMIT,
    });

    // ⚠️ 名称反查叠加 `visibleFoodWhere(userId)`（K7）：不得反查出**他人私有**自定义食物的名称。
    const ids = [...new Set(grouped.map((row) => row.foodItemId).filter((id): id is number => id !== null))];
    const nameById = new Map<number, string>();
    if (ids.length > 0) {
      const rows = await this.prisma.foodItem.findMany({
        where: { id: { in: ids }, ...visibleFoodWhere(userId) },
        select: { id: true, name: true },
      });
      for (const row of rows) {
        nameById.set(row.id, row.name);
      }
    }

    const projection: FoodRefRow[] = grouped.map((row) => ({
      foodItemId: row.foodItemId,
      customName: row.customName,
      foodName: row.foodItemId === null ? null : (nameById.get(row.foodItemId) ?? null),
      loggedDate: row.loggedDate,
    }));

    return { projection, dates: grouped.map((row) => row.loggedDate) };
  }

  /**
   * 微量营养素：按 `grams/100` 折算食物条目的每 100g 营养素并汇总（快速加卡无微量数据，跳过）。
   *
   * 🔴 **缺失值必须是 `null`，不能是 0**（`/why-numbers` ⑯ 的承诺，NFR-11 红线）。
   *
   * 此前写成 `(per100g ?? 0) * factor` —— 把「没查到」静默折叠成 0，照常求和、照常除分母、
   * 照常渲染。于是 10 项里 5 项 `atMost`（建议不超过）的 `0 ≤ 参考` 恒成立，
   * 用户看到「达标 ✓」：**把数据缺失误报成「吃得很健康」**。
   *
   * 实测本仓库 dev.db（1789 条食物）的缺失率：
   *   糖 80.0% ｜ 纤维 72.8% ｜ 饱和脂肪 65.7% ｜ 镁 34.1% ｜ 钾 32.9%
   *   维生素 D **100%** ｜ B12 **100%**  ← 这两项恒为 0，即恒显示「0 µg 达标 ✓」
   *
   * 口径：
   * - `null` = 这条记录对该项**无数据**（原样透传，不折算）；
   * - `0` = 有数据且确实是 0（保留，0 是合法测量值，不是缺失）；
   * - 汇总时**只要窗口内有一条缺失，整项返回 `null`** —— 半个窗口的数字会让用户
   *   误以为「这就是全部」，比留空更危险（宁可少说，不可说错）。
   */
  private async micronutrientRows(
    userId: number,
    from: string,
    to: string,
  ): Promise<Array<Record<MicronutrientKey, number | null>>> {
    const rows = await this.prisma.mealLog.findMany({
      where: { userId, loggedDate: { gte: from, lte: to }, foodItemId: { not: null } },
      include: {
        foodItem: {
          select: {
            fatGPer100g: true,
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
      /**
       * 缺失即 `null`（不折算、不兜 0）。
       *
       * ⚠️ 饱和脂肪额外做**合理性校验**（`/why-numbers` ⑯「推算值必须 ≤ 总脂肪」）：
       * 库里有 3 条脏数据（梨罐头 / 咖啡（现煮）/ 红茶（冲泡），均为 `fat=0, sfa=0.002`），
       * 照原样显示会得到「脂肪 0 g、饱和脂肪 0.002 g」这种自相矛盾的数字 → 判异常留空。
       * 另两项无数据的 `nutrient` 不做校验（缺失已经走 `null` 分支）。
       */
      const value = (per100g: number | null | undefined): number | null => {
        if (food === null || per100g === null || per100g === undefined) {
          return null;
        }
        return per100g * factor;
      };
      const saturatedFatRaw = food?.saturatedFatGPer100g ?? null;
      const totalFat = food?.fatGPer100g ?? null;
      const saturatedFat =
        saturatedFatRaw !== null && totalFat !== null && saturatedFatRaw > totalFat
          ? null // 推算值 > 总脂肪 = 数据异常，按 ⑯ 判异常留空
          : value(saturatedFatRaw);

      return {
        fiberG: value(food?.fiberGPer100g),
        sodiumMg: value(food?.sodiumMgPer100g),
        sugarG: value(food?.sugarGPer100g),
        saturatedFatG: saturatedFat,
        calciumMg: value(food?.calciumMgPer100g),
        ironMg: value(food?.ironMgPer100g),
        potassiumMg: value(food?.potassiumMgPer100g),
        vitaminDUg: value(food?.vitaminDUgPer100g),
        b12Ug: value(food?.b12UgPer100g),
        magnesiumMg: value(food?.magnesiumMgPer100g),
      };
    });
  }

  /**
   * 汇总一项微量营养素。
   *
   * 🔴 **有一条缺失就整项返回 `null`**（`/why-numbers` ⑯「宁可留空，也不猜」）：
   * 把缺失当 0 求和会得到一个「看起来正常、实则偏低」的数字，并据此判「达标」——
   * 方向错在「让用户放心」这一侧。半个窗口的数字同样误导（用户会以为那就是全部）。
   *
   * - 窗口内**没有任何记录** → `null`（无从得知，不是 0）；
   * - 全部有值 → 正常求和（含合法的 0）。
   */
  private sumMicronutrient(
    rows: Array<Record<MicronutrientKey, number | null>>,
    key: MicronutrientKey,
  ): number | null {
    if (rows.length === 0) {
      return null;
    }
    let sum = 0;
    for (const row of rows) {
      const value = row[key];
      if (value === null) {
        return null;
      }
      sum += value;
    }
    return sum;
  }

  private round1(value: number): number {
    return Math.round(value * 10) / 10;
  }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
