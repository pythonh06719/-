/**
 * 阶段回顾聚合（core/report/period.ts）—— R11.3 的**口径唯一实现**（零 IO、零依赖）。
 *
 * 分层（D-1）：SQL 下推产出 {@link PeriodFacts}（**聚合事实**，不是原始行 —— AC-11.3.8），
 * 本模块把事实归并为 {@link PeriodSummary}。API 层只做查询编排，不出现口径逻辑。
 *
 * **反评判红线（AC-11.3.2 / 11.3.3）在类型层封口**：
 * - `PeriodSummary` 只有白名单 6 类字段，结构上**不存在**「完成度 / 达成率 / 连续记录」的位置；
 * - 体重只产出 `{startKg, endKg, deltaKg} | null`，core 不产出任何评价语句；
 * - 「有记录的天数」**不产出**分母 —— 分母（`X/Y` 式）由调用方自造是违规，本模块无从提供。
 *
 * 本模块不得 import `@qsh/shared-types`（K12），返回形状用本模块自己的 interface 承载。
 */

import type { FoodRefRow } from '../food/identity';
import { distinctFoodKeys } from '../food/identity';
import { round2 } from '../calorie/rounding';
// 日期键工具下沉到 `date/daykey.ts`：与周报窗口（report/week.ts）共用同一套实现，不各写一份。
import { normalizeLocalDateKey, shiftLocalDateKey } from '../date/daykey';

/** 阶段回顾允许的档位（QR-3：只 30 / 365 两档，不做 90 天档）。 */
export const PERIOD_DAY_OPTIONS = [30, 365] as const;

/** 档位类型（与 shared-types 的 `PeriodDays` 保持同构，由 API 层映射）。 */
export type PeriodDaysOption = (typeof PERIOD_DAY_OPTIONS)[number];

/** 白名单指标 ④ 的展示上限（PM：并列时最多展示 2 个）。 */
export const PERIOD_TOP_HABITS = 2;

/**
 * 解析回顾区间（纯函数，`todayKey` 由参数注入 —— K8 禁 `Date.now()`）。
 *
 * - `days` 不在 {30, 365} → `null`（API 层转 400；**不允许隐式默认**，避免口径猜测）；
 * - `endDateKey` 缺失 / 晚于今天 → 裁剪到今天（AC-11.3.7「区间含未来日期」边界）；
 * - `endDateKey` 不是合法 `YYYY-MM-DD` → 视同缺省，用今天。
 *
 * @param days 档位（30 / 365）
 * @param endDateKey 请求的结束日期（可缺省）
 * @param todayKey 今天的本地日期键（注入）
 * @returns `{ from, to }`；档位非法时 `null`
 */
export function resolvePeriodWindow(
  days: number,
  endDateKey: string | null,
  todayKey: string,
): { from: string; to: string } | null {
  if (!PERIOD_DAY_OPTIONS.includes(days as PeriodDaysOption)) {
    return null;
  }
  const today = normalizeDateKey(todayKey);
  if (today === null) {
    return null;
  }
  const requested = normalizeDateKey(endDateKey);
  // 结束日期晚于今天（或非法/缺省）→ 裁剪到今天
  const to = requested !== null && requested <= today ? requested : today;
  const from = shiftDaysKey(to, -(days - 1));
  return { from, to };
}

/** SQL 下推后的**聚合事实**（不是原始行 —— AC-11.3.8）。 */
export interface PeriodFacts {
  /** 各表 `groupBy(loggedDate)` 日期键的并集（≤365 项，来自 SQL，不是原始行） */
  loggedDates: readonly string[];
  /** 食物身份投影（groupBy 三元组 + 名称反查，与 `foods.top` 同构） */
  foodRows: readonly FoodRefRow[];
  /** `meal_logs` 行数（SQL count） */
  mealEntryCount: number;
  /** 习惯聚合（`groupBy(habitId)` + 名称反查，仅 done=true） */
  habitCounts: ReadonlyArray<{ habitId: number; name: string; count: number }>;
  /** 运动聚合（SQL groupBy(loggedDate) 的 _count/_sum 求和） */
  exercise: { sessions: number; totalMinutes: number };
  /** 体重首条（find asc）——带 id 用于判重；区间无记录为 null */
  weightFirst: { id: number; date: string; weightKg: number } | null;
  /** 体重末条（find desc）；区间无记录为 null */
  weightLast: { id: number; date: string; weightKg: number } | null;
  /** 非体重胜利条数（winLog groupBy 的 count 和） */
  winCount: number;
}

/** 阶段回顾摘要（白名单 6 类指标，一个不多 —— AC-11.3.2）。 */
export interface PeriodSummary {
  from: string;
  to: string;
  /** 区间内至少有一天有记录 */
  hasAnyData: boolean;
  /** ① 有记录的天数 */
  loggedDays: number;
  /** ② 不同食物种类数（与 R11.7 共用 `distinctFoodKeys`，K16） */
  distinctFoodCount: number;
  /** ③ 餐次条目总数 */
  mealEntryCount: number;
  /** ④ 记到最多的习惯（≤ {@link PERIOD_TOP_HABITS}） */
  topHabits: Array<{ habitId: number; name: string; count: number }>;
  /** ⑤ 运动次数与总时长 */
  exercise: { sessions: number; totalMinutes: number };
  /** ⑥ 体重变化量；任一端缺失 / 首末是同一条记录 → null（整块隐藏，不显示 0） */
  weight: { startKg: number; endKg: number; deltaKg: number } | null;
  /** 「体重之外的变化」条数（唯一允许的计数出口，AC-11.4.6） */
  winCount: number;
}

/**
 * 归并聚合事实为回顾摘要（纯计算；`distinctFoodCount` 内部调用 `distinctFoodKeys` —— K16 防漂移）。
 *
 * @param facts SQL 下推得到的聚合事实
 * @param options 已解析的区间（`resolvePeriodWindow` 的产物；`from > to` 视为空区间）
 */
export function summarizePeriod(
  facts: PeriodFacts,
  options: { from: string; to: string },
): PeriodSummary {
  const from = normalizeDateKey(options.from) ?? options.from;
  const to = normalizeDateKey(options.to) ?? options.to;

  // ① 有记录的天数：只计落在 [from, to] 内的日期（未来日期被裁掉 —— AC-11.3.7）
  const loggedDays = new Set<string>();
  for (const date of facts.loggedDates) {
    const key = normalizeDateKey(date);
    if (key !== null && key >= from && key <= to) {
      loggedDays.add(key);
    }
  }

  // ② 不同食物种类数：与周报同一个函数（K16），只要计数不要清单 → 上限给安全整数（不截断计数）
  const distinctFoodCount = distinctFoodKeys(facts.foodRows, { limit: Number.MAX_SAFE_INTEGER }).count;

  // ④ topHabits：count desc → habitId asc，取前 2（并列时确定可复现，Q-3）
  const topHabits = [...facts.habitCounts]
    .sort((a, b) => (b.count - a.count) || (a.habitId - b.habitId))
    .slice(0, PERIOD_TOP_HABITS)
    .map((habit) => ({ habitId: habit.habitId, name: habit.name, count: habit.count }));

  // ⑥ 体重：首末**两条不同记录**才产出；只有 1 条（id 相同）或任一端缺失 → null
  const first = facts.weightFirst;
  const last = facts.weightLast;
  const weight =
    first !== null && last !== null && first.id !== last.id
      ? { startKg: first.weightKg, endKg: last.weightKg, deltaKg: round2(last.weightKg - first.weightKg) }
      : null;

  return {
    from,
    to,
    hasAnyData: loggedDays.size > 0,
    loggedDays: loggedDays.size,
    distinctFoodCount,
    mealEntryCount: facts.mealEntryCount,
    topHabits,
    exercise: {
      sessions: Math.max(0, Math.floor(facts.exercise.sessions)),
      totalMinutes: Math.max(0, Math.floor(facts.exercise.totalMinutes)),
    },
    weight,
    winCount: Math.max(0, Math.floor(facts.winCount)),
  };
}

/**
 * 归一 `YYYY-MM-DD`（宽松到 1 位月/日，归一成两位）；非法输入返回 `null`。
 *
 * 实现下沉到 `date/daykey.ts`（`normalizeLocalDateKey`），此处仅做同义包装，
 * 保证本文件原有调用点（含「不存在日期」的回环校验口径）一字不改。
 */
function normalizeDateKey(value: string | null | undefined): string | null {
  return normalizeLocalDateKey(value);
}

/** 本地日历天加减（不引入 Date.now，输入已归一）。 */
function shiftDaysKey(dateKey: string, delta: number): string {
  return shiftLocalDateKey(dateKey, delta);
}
