/**
 * 周报窗口（core/report/week.ts）—— B2「周报可回看历史周」的**口径唯一实现**（零 IO、零依赖）。
 *
 * 分层（D-1）：本模块只回答三件事，其余交给调用方渲染 ——
 *   ① 某一周的边界在哪（`resolveWeekWindow`）；
 *   ② 往前 / 往后翻一周落在哪一天（`shiftWeekEndDate` / `canShiftWeekForward`）；
 *   ③ 这一周是「几周前」（`weeksBeforeToday`，供 UI 说清自己在看哪一周）。
 *
 * **周的口径（与后端 `GET /report/weekly?endDate=` 完全一致，AC-B2）**：
 * 一周 = 「以 `endDate` 为最后一天、往前数 7 天」的闭区间 `[endDate-6, endDate]`。
 * 后端 `ReportService.weekly()` 用的是同一个算式（`from = addDays(to, -6)`），
 * 前端**不得**另算一套（否则会出现「标签写着 A 区间、数字来自 B 区间」）。
 *
 * **未来禁用（AC-B2）**：`endDate` 一律不晚于今天 —— 未来没有记录可看，
 * 因此 `resolveWeekWindow` 会把晚于今天的请求裁剪到今天，`shiftWeekEndDate` 也不会越过今天。
 * **往前翻不设硬上限**：后端支持任意 `endDate`，本模块不做任何下限裁剪。
 *
 * **可解释性（NFR-11）**：换周**只换窗口**，不引入任何新数字与新算法 ——
 * 本模块不产出指标，只产出窗口边界。
 *
 * 本模块不得 import `@qsh/shared-types`（K12）。
 */

import { diffLocalDateKeys, normalizeLocalDateKey, shiftLocalDateKey } from '../date/daykey';

/** 一周的天数（周报窗口固定 7 天，改这个常量等于改口径，需同步后端）。 */
export const WEEK_WINDOW_DAYS = 7;

/** 周窗口（闭区间，两端都是 `YYYY-MM-DD`）。 */
export interface WeekWindow {
  /** 窗口首日（`to` 往前 6 天） */
  from: string;
  /** 窗口末日（= 请求的 `endDate`，不晚于今天） */
  to: string;
}

/**
 * 解析周报窗口（纯函数；`todayKey` 由参数注入 —— K8 禁 `Date.now()`）。
 *
 * - `endDateKey` 缺失 / 非法 / 晚于今天 → 裁剪到今天（未来禁用）；
 * - `todayKey` 非法 → `null`（调用方按「拿不到窗口」处理，不猜一个日期）。
 *
 * @param endDateKey 请求的周最后一天（可缺省）
 * @param todayKey 今天的本地日期键（注入）
 * @returns 窗口 `{ from, to }`；今天非法时 `null`
 */
export function resolveWeekWindow(endDateKey: string | null | undefined, todayKey: string): WeekWindow | null {
  const today = normalizeLocalDateKey(todayKey);
  if (today === null) {
    return null;
  }
  const requested = normalizeLocalDateKey(endDateKey);
  const to = requested !== null && requested <= today ? requested : today;
  const from = shiftLocalDateKey(to, -(WEEK_WINDOW_DAYS - 1));
  return { from, to };
}

/**
 * 按周平移窗口末日（纯函数）。
 *
 * - `deltaWeeks` 为负 → 往前翻（`|deltaWeeks|` 周），**不设下限**；
 * - `deltaWeeks` 为正 → 往后翻，但**永不越过今天**（未来禁用）；
 * - 入参非法 / 越过今天 → 收敛到今天。
 *
 * ⚠️ 调用方应先用 {@link canShiftWeekForward} 判断能否往后翻并禁用按钮 ——
 * 本函数即便被调用也不会返回未来日期（双保险）。
 */
export function shiftWeekEndDate(endDateKey: string, deltaWeeks: number, todayKey: string): string {
  const window = resolveWeekWindow(endDateKey, todayKey);
  if (window === null) {
    return todayKey;
  }
  const delta = Number.isFinite(deltaWeeks) ? Math.trunc(deltaWeeks) : 0;
  const next = shiftLocalDateKey(window.to, delta * WEEK_WINDOW_DAYS);
  return next > window.to && next > todayKeyNormalized(todayKey) ? todayKeyNormalized(todayKey) : next;
}

/** 往后翻一周是否可行（`endDate + 7` 不晚于今天）。未来周按钮据此禁用（而非隐藏后失效）。 */
export function canShiftWeekForward(endDateKey: string, todayKey: string): boolean {
  const window = resolveWeekWindow(endDateKey, todayKey);
  if (window === null) {
    return false;
  }
  const today = todayKeyNormalized(todayKey);
  return shiftLocalDateKey(window.to, WEEK_WINDOW_DAYS) <= today;
}

/**
 * 这一周是「几周前」（0 = 本周，1 = 上一周，2 = 两周前 …）。
 *
 * 用于 UI 把「自己在看哪一周」说清楚（NFR-11 可解释性）；
 * 按 `ceil` 计：窗口末日落在「过去第 N 个 7 天」内即为 N。
 */
export function weeksBeforeToday(endDateKey: string, todayKey: string): number {
  const window = resolveWeekWindow(endDateKey, todayKey);
  const today = todayKeyNormalized(todayKey);
  if (window === null) {
    return 0;
  }
  const diff = diffLocalDateKeys(window.to, today);
  if (!Number.isFinite(diff) || diff <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(diff / WEEK_WINDOW_DAYS));
}

/**
 * 一周内是否留下过任何记录（纯函数，供「历史周空态」判定）。
 *
 * **为什么要单独判定**：后端对任意历史周都会返回 7 天结构（缺记录即为 0），
 * 直接把这一排 0 渲染出来就是一面「0 千卡 / 0 次打卡」墙 —— 那会被读成评判（无负罪感红线）。
 * 判为「无记录」时 UI 走中性空态，**不渲染任何 0 值指标**。
 *
 * 判定口径（任一为真即算有记录）：
 * - 日均摄入 / 运动合计 > 0；
 * - 该周吃到过 ≥1 种食物；
 * - 有体重变化量（区间内 ≥2 条体重记录）；
 * - 任一天有摄入 / 运动 / 饮水 / 习惯打卡。
 *
 * 字段全部可选且容忍 `null`：后端字段缺失（旧缓存 / 桩数据）时按「无记录」处理，不抛错。
 */
export interface WeeklyRecordFacts {
  /** 日均摄入 kcal */
  avgIntakeKcal?: number | null;
  /** 运动消耗合计 kcal */
  totalExerciseKcal?: number | null;
  /** 不同食物种类数 */
  distinctFoodCount?: number | null;
  /** 体重变化量（区间内不足两条记录时为 null） */
  weightChangeKg?: number | null;
  /** 逐日聚合（缺字段时按空数组处理） */
  days?: ReadonlyArray<{
    intakeKcal?: number | null;
    exerciseKcal?: number | null;
    waterMl?: number | null;
    habitsDone?: number | null;
  }> | null;
}

/** 一周内是否有任何记录（{@link WeeklyRecordFacts} 的判定入口）。 */
export function hasAnyWeeklyRecord(facts: WeeklyRecordFacts | null | undefined): boolean {
  if (facts === null || facts === undefined) {
    return false;
  }
  if (positive(facts.avgIntakeKcal) || positive(facts.totalExerciseKcal) || positive(facts.distinctFoodCount)) {
    return true;
  }
  if (typeof facts.weightChangeKg === 'number' && Number.isFinite(facts.weightChangeKg)) {
    return true;
  }
  const days = Array.isArray(facts.days) ? facts.days : [];
  for (const day of days) {
    if (day === null || day === undefined) {
      continue;
    }
    if (positive(day.intakeKcal) || positive(day.exerciseKcal) || positive(day.waterMl) || positive(day.habitsDone)) {
      return true;
    }
  }
  return false;
}

/** 正值判定（非数字 / null / ≤0 一律不算「有记录」）。 */
function positive(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 归一今天（非法时原样返回，调用方已保证不出现该分支）。 */
function todayKeyNormalized(todayKey: string): string {
  return normalizeLocalDateKey(todayKey) ?? todayKey;
}
