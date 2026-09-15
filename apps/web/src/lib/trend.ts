import type { MovingAveragePoint, WeightTrendPoint } from '@qsh/shared-types';
import { addDays, diffDays, parseDateKey, todayKey } from './format';

/**
 * 体重趋势与 7 日移动平均（lib/trend.ts）—— **纯函数**，便于单元测试（T04 DoD）。
 *
 * 规则（PRD R7.2 / TC-34）：
 * - 对每个「有记录的日期」，取**以该日为终点、往前 7 个自然日（含当日）**窗口内的所有记录，求算术平均；
 * - **不足 7 天**时，用窗口内**已有的点**求平均（不补零、不外推），因此首日 = 首日体重；
 * - 窗口内**没有任何记录**时返回 `null`（图表断点）；
 * - 结果保留 2 位小数（与 `WeightTrendResponse.movingAverage7` 契约一致）。
 *
 * 优先消费后端算好的 `WeightTrendResponse.movingAverage7`；后端不可用时前端本地计算（离线可用），两者算法保持一致。
 */

/** 移动平均窗口天数（契约固定 7）。 */
export const MOVING_AVERAGE_WINDOW_DAYS = 7;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 按日期升序排序（返回新数组，不修改入参）。 */
export function sortTrendPoints(points: readonly WeightTrendPoint[]): WeightTrendPoint[] {
  return [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 计算 7 日移动平均线。
 *
 * @param points 原始体重点（任意顺序，函数内部排序）
 * @returns 与输入日期对齐的移动平均点（升序）
 */
export function computeMovingAverage7d(
  points: readonly WeightTrendPoint[],
): MovingAveragePoint[] {
  const sorted = sortTrendPoints(points);
  return sorted.map((point) => {
    const windowStart = addDays(point.date, -(MOVING_AVERAGE_WINDOW_DAYS - 1));
    const inWindow = sorted.filter(
      (candidate) => candidate.date >= windowStart && candidate.date <= point.date,
    );
    if (inWindow.length === 0) {
      return { date: point.date, value: null };
    }
    const sum = inWindow.reduce((acc, candidate) => acc + candidate.weightKg, 0);
    return { date: point.date, value: round2(sum / inWindow.length) };
  });
}

/** 体重趋势统计（最小 / 最大 / 最新 / 净变化）。 */
export interface TrendStats {
  minKg: number | null;
  maxKg: number | null;
  latestKg: number | null;
  /** 最新 − 最早（可正可负） */
  changeKg: number | null;
}

/** 计算趋势统计（纯函数）。 */
export function computeTrendStats(points: readonly WeightTrendPoint[]): TrendStats {
  if (points.length === 0) {
    return { minKg: null, maxKg: null, latestKg: null, changeKg: null };
  }
  const sorted = sortTrendPoints(points);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) {
    return { minKg: null, maxKg: null, latestKg: null, changeKg: null };
  }
  let minKg = first.weightKg;
  let maxKg = first.weightKg;
  for (const point of sorted) {
    if (point.weightKg < minKg) {
      minKg = point.weightKg;
    }
    if (point.weightKg > maxKg) {
      maxKg = point.weightKg;
    }
  }
  return {
    minKg: round2(minKg),
    maxKg: round2(maxKg),
    latestKg: round2(last.weightKg),
    changeKg: round2(last.weightKg - first.weightKg),
  };
}

/**
 * 把后端 `logs`（或任意 `{loggedAt, weightKg}`）归一为趋势点。
 * 支持 `loggedAt` / `date` 两种字段名，避免与 T03 返回形态不一致时白屏。
 */
export function toTrendPoints(
  logs: ReadonlyArray<{ loggedAt?: string; date?: string; weightKg: number }>,
): WeightTrendPoint[] {
  const points: WeightTrendPoint[] = [];
  for (const log of logs) {
    const date = log.date ?? log.loggedAt;
    if (typeof date !== 'string' || !Number.isFinite(log.weightKg)) {
      continue;
    }
    points.push({ date, weightKg: log.weightKg });
  }
  return sortTrendPoints(points);
}

/**
 * 构造最近 `days` 天的迷你趋势（看板用）。
 * 无记录的日期以 `null` 填充，保证折线图时间轴连续。
 */
export function buildMiniTrend(
  points: readonly WeightTrendPoint[],
  days = MOVING_AVERAGE_WINDOW_DAYS,
  now: Date = new Date(),
): Array<{ date: string; weightKg: number | null }> {
  const today = todayKey(now);
  const byDate = new Map<string, number>();
  for (const point of points) {
    byDate.set(point.date, point.weightKg);
  }
  const result: Array<{ date: string; weightKg: number | null }> = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    const weight = byDate.get(date);
    result.push({ date, weightKg: weight === undefined ? null : weight });
  }
  return result;
}

/**
 * 对比最新两点，判断体重是否「上涨」。
 * 用于展示无负罪感文案「波动很正常，看趋势就好」（TC-34 / PRD §7）。
 */
export function isWeightRising(points: readonly WeightTrendPoint[]): boolean {
  if (points.length < 2) {
    return false;
  }
  const sorted = sortTrendPoints(points);
  const last = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  if (last === undefined || prev === undefined) {
    return false;
  }
  return last.weightKg > prev.weightKg;
}

/** 两点间天数（用于「距上次记录 N 天」等提示，避免依赖 Date.now 的隐式调用）。 */
export function daysBetween(a: string, b: string): number {
  return diffDays(a, b);
}

/** 供测试复用：从日期键还原本地 Date。 */
export { parseDateKey };
