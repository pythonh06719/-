/**
 * 目标达成预测曲线（R2.6）—— **纯函数、唯一真源**。
 *
 * 从当前起始体重（`startDate` 当天）**匀速线性**降到目标体重（`startDate + targetWeeks × 7` 天），
 * **每周一个数据点**（含首尾共 `targetWeeks + 1` 个），供前端趋势图画出「目标预测」虚线。
 *
 * 设计约束：
 * - 零 IO、零运行时依赖（`@qsh/core` 铁律）；不读取 `Date.now()` —— 日期完全由参数决定（K8）；
 * - 日粒度一律使用**本地时区** `YYYY-MM-DD`（复用 `date/daykey` 的 `toLocalDateKey`）；
 * - 无法给出有意义预测时返回 `[]`（而非抛错），调用方无需 try/catch。
 */

import { toLocalDateKey } from '../date/daykey';

/** 目标预测曲线上的一个点（与 `WeightTrendPoint` 形状一致，便于图表复用）。 */
export interface GoalForecastPoint {
  /** `YYYY-MM-DD`（本地日期） */
  date: string;
  /** 该周的预测体重 kg */
  weightKg: number;
}

/** `buildGoalForecast` 的输入（来自当前生效目标 `user_goals`）。 */
export interface GoalForecastInput {
  /** 起始体重 kg（`startDate` 当天的体重） */
  startWeightKg: number;
  /** 目标体重 kg */
  targetWeightKg: number;
  /** 目标周数（正整数） */
  targetWeeks: number;
  /** 起始日期 `YYYY-MM-DD`（本地日期） */
  startDate: string;
}

/** 一周的天数。 */
const DAYS_PER_WEEK = 7;

/** `YYYY-MM-DD` 形态校验（宽松：允许 1~2 位月/日，真实存在性交由 `Date` 归一）。 */
const DATE_KEY_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/**
 * 把 `YYYY-MM-DD` 按**本地时区**解析为 `Date`（当天 00:00）。
 * 非该格式时返回 `null`（调用方据此短路，避免产生 `NaN-NaN-NaN` 的脏日期）。
 */
function parseLocalDateKey(value: string): Date | null {
  const matched = DATE_KEY_PATTERN.exec(value);
  if (matched === null) {
    return null;
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 在本地日期上增加天数（跨月 / 跨年 / 闰年由 `Date` 处理）。
 *
 * @param date 起点（本地当天 00:00）
 * @param days 偏移天数
 * @returns `YYYY-MM-DD`（本地）
 */
function addLocalDays(date: Date, days: number): string {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return toLocalDateKey(next);
}

/**
 * 生成目标达成预测曲线（R2.6）。
 *
 * 从 `startWeightKg`（`startDate` 当天）匀速线性降到 `targetWeightKg`
 * （`startDate + targetWeeks × 7` 天），**每周一个点**（含首尾共 `targetWeeks + 1` 个）。
 * 末点**精确等于** `targetWeightKg`（显式赋值，规避浮点误差导致的末点残留）。
 *
 * 返回 `[]` 的情形：
 * - `targetWeeks <= 0`；
 * - `startWeightKg <= targetWeightKg`（无需减重）；
 * - `startWeightKg` / `targetWeightKg` / `targetWeeks` 任一**非有限**（`NaN` / `±Infinity`）；
 * - `startDate` 非 `YYYY-MM-DD` 形态。
 *
 * @param input 目标参数（见 {@link GoalForecastInput}）
 * @returns 升序预测点数组；不可预测时为空数组
 */
export function buildGoalForecast(input: GoalForecastInput): GoalForecastPoint[] {
  const { startWeightKg, targetWeightKg, targetWeeks, startDate } = input;

  // 非有限数值无法预测
  if (
    !Number.isFinite(startWeightKg) ||
    !Number.isFinite(targetWeightKg) ||
    !Number.isFinite(targetWeeks)
  ) {
    return [];
  }

  // 周数必须为正整数（落库为 Int；小数向下取整，不足 1 周视为不可预测）
  const weeks = Math.floor(targetWeeks);
  if (weeks <= 0) {
    return [];
  }

  // 已经达到 / 低于目标体重：无需预测
  if (startWeightKg <= targetWeightKg) {
    return [];
  }

  const start = parseLocalDateKey(startDate);
  if (start === null) {
    return [];
  }

  const totalLoss = startWeightKg - targetWeightKg;
  const points: GoalForecastPoint[] = [];
  for (let week = 0; week <= weeks; week += 1) {
    const date = addLocalDays(start, week * DAYS_PER_WEEK);
    // 末点显式取目标体重，保证「末点 == targetWeightKg」精确成立（无浮点残留）
    const weightKg =
      week === weeks
        ? targetWeightKg
        : startWeightKg - (totalLoss * week) / weeks;
    points.push({ date, weightKg });
  }
  return points;
}
