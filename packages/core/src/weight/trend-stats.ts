/**
 * 体重**区间统计**的唯一真源（NFR-11 / R7.2 / C4 区间视图）。
 *
 * 背景：与移动平均同构的「同一数字两份实现」—— 服务端 `WeightsService.list()` 内联循环算
 * `minKg / maxKg / latestKg / changeKg`，前端 `lib/trend.ts` 的 `computeTrendStats` 另有一份。
 * 两者口径此前并不一致（已实测），这里收敛为一份纯函数，两侧都改调它。
 *
 * **口径（以原前端实现为准）**：
 * - **读数一律 `round2`**：`minKg / maxKg / meanKg / latestKg / changeKg` 全部保留 2 位小数。
 *   原后端对 `min/max/latest` **不取整**（直接吐 DB 原始值），会输出 `59.876` 这种三位小数 ——
 *   对用户那是噪音不是精度，故统一为取整；
 * - **`changeKg` = 最晚日体重 − 最早日体重**，取整发生在**相减之后**（不是先取整再相减）；
 * - **最早 / 最晚按日期取**，不按数组顺序 —— 原后端依赖 Prisma 的 `orderBy: loggedAt asc`
 *   取 `logs[0]` 与末元素，一旦入参不是升序，`latestKg` 与 `changeKg` 的**符号会翻转**。
 *   真源显式排序，不再依赖调用方的入参顺序；
 * - **空输入 → 五个字段全 `null`**（不是 `0`）；
 * - `meanKg` 为区间内所有记录的算术平均（**不是**移动平均）。
 *
 * ⚠️ **记一笔（只读，不要据此改代码）**：`CreateWeightDto` 对 `weightKg` 只有
 * `0.1–499.9` 的**范围**约束、**没有精度/小数位约束**，且 `create()` 与 CSV 导入
 * （`parseWeightCsv`）落库时都不取整 —— 所以库里**可能存在**超过 2 位小数的体重值。
 * 这正是「后端不取整」那半边能被触发的原因。统一后的读路径已保证两侧逐值相等，
 * 因此**刻意不**去改 DTO / 写入路径：那会不可逆地改写存量数据，且治不了本分歧。
 */

import { round2 } from '../calorie/rounding';

/** 输入点：任意 `{ date, weightKg }`（`WeightTrendPoint` / `WeightLog` 均结构兼容）。 */
export interface TrendStatsInputPoint {
  /** `YYYY-MM-DD` */
  date: string;
  /** 体重 kg */
  weightKg: number;
}

/** 区间统计结果（无记录时五字段全为 `null`）。 */
export interface TrendStatsResult {
  /** 区间最小体重 kg */
  minKg: number | null;
  /** 区间最大体重 kg */
  maxKg: number | null;
  /** 区间内所有记录的算术平均 kg（**不是**移动平均） */
  meanKg: number | null;
  /** 最晚一天的体重 kg */
  latestKg: number | null;
  /** 最晚 − 最早（可正可负） */
  changeKg: number | null;
}

/** 空区间统计（五字段全 `null`）。 */
const EMPTY_TREND_STATS: TrendStatsResult = {
  minKg: null,
  maxKg: null,
  meanKg: null,
  latestKg: null,
  changeKg: null,
};

/**
 * 计算区间统计（纯函数）。传入哪个区间就统计哪个区间。
 *
 * @param points 原始体重点（任意顺序，函数内部按日期升序排序；不修改入参）
 */
export function computeTrendStats(
  points: readonly TrendStatsInputPoint[],
): TrendStatsResult {
  if (points.length === 0) {
    return { ...EMPTY_TREND_STATS };
  }

  // 显式排序：最早 / 最晚按**日期**取，不依赖调用方的入参顺序
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) {
    return { ...EMPTY_TREND_STATS };
  }

  let minKg = first.weightKg;
  let maxKg = first.weightKg;
  let sumKg = 0;
  for (const point of sorted) {
    if (point.weightKg < minKg) {
      minKg = point.weightKg;
    }
    if (point.weightKg > maxKg) {
      maxKg = point.weightKg;
    }
    sumKg += point.weightKg;
  }

  return {
    minKg: round2(minKg),
    maxKg: round2(maxKg),
    meanKg: round2(sumKg / sorted.length),
    latestKg: round2(last.weightKg),
    // 取整发生在**相减之后**，不是先取整再相减
    changeKg: round2(last.weightKg - first.weightKg),
  };
}

// ---------------------------------------------------------------------------
// 跨端一致性基线（NFR-11）
// ---------------------------------------------------------------------------

/** 一条共享边界用例（输入 + 期望输出），供 `core` / `apps/api` / `apps/web` 三处测试共用。 */
export interface TrendStatsSharedCase {
  /** 用例名（出现在测试报告里，便于定位） */
  name: string;
  /** 输入体重点（刻意含乱序 / 超过 2 位小数等形态） */
  points: TrendStatsInputPoint[];
  /** 期望输出：五字段逐值相等 */
  expected: TrendStatsResult;
}

/**
 * **共享边界用例集** —— 与 `MOVING_AVERAGE_SHARED_CASES` 同一模式：把「服务端与前端
 * 统计口径一致」从注释变成断言。
 *
 * 覆盖：空数组、单条、升序常规、**输入降序**（守 earliest/latest 与 change 符号）、
 * **超过 2 位小数**（守读数取整）、change 正负、浮点噪声、`.005` 取整边界、min/max 落在中间点。
 *
 * 三处测试（core 单测 / api service / web trend）都跑这同一份数据并断言逐值相等：
 * - core / web：比**五字段**（含 `meanKg`）；
 * - api：`WeightListResult.stats` 按契约只有四字段（无 `meanKg`），故比其中四项。
 *
 * ⚠️ 期望值即**统一后的目标口径**（= 原前端口径）快照。要改判据必须先改这里。
 */
export const TREND_STATS_SHARED_CASES: readonly TrendStatsSharedCase[] = [
  {
    name: '空数组 → 五字段全 null（不是 0）',
    points: [],
    expected: { minKg: null, maxKg: null, meanKg: null, latestKg: null, changeKg: null },
  },
  {
    name: '单条 → min = max = mean = latest，change = 0',
    points: [{ date: '2026-09-01', weightKg: 60 }],
    expected: { minKg: 60, maxKg: 60, meanKg: 60, latestKg: 60, changeKg: 0 },
  },
  {
    name: '升序常规（3 天）',
    points: [
      { date: '2026-09-01', weightKg: 60 },
      { date: '2026-09-02', weightKg: 58.4 },
      { date: '2026-09-03', weightKg: 59.2 },
    ],
    expected: { minKg: 58.4, maxKg: 60, meanKg: 59.2, latestKg: 59.2, changeKg: -0.8 },
  },
  {
    name: '★ 输入降序 → earliest/latest 按日期取，change 符号不翻转',
    points: [
      { date: '2026-09-03', weightKg: 64 },
      { date: '2026-09-02', weightKg: 62 },
      { date: '2026-09-01', weightKg: 60 },
    ],
    // 原后端按数组顺序会得到 latestKg=60 / changeKg=-4（符号相反）
    expected: { minKg: 60, maxKg: 64, meanKg: 62, latestKg: 64, changeKg: 4 },
  },
  {
    name: 'change 为负',
    points: [
      { date: '2026-09-01', weightKg: 70 },
      { date: '2026-09-02', weightKg: 68.5 },
    ],
    expected: { minKg: 68.5, maxKg: 70, meanKg: 69.25, latestKg: 68.5, changeKg: -1.5 },
  },
  {
    name: 'change 为正',
    points: [
      { date: '2026-09-01', weightKg: 68.5 },
      { date: '2026-09-02', weightKg: 70 },
    ],
    expected: { minKg: 68.5, maxKg: 70, meanKg: 69.25, latestKg: 70, changeKg: 1.5 },
  },
  {
    name: '★ 超过 2 位小数 → 读数一律 round2（不吐 59.876）',
    points: [
      { date: '2026-09-01', weightKg: 60.555 },
      { date: '2026-09-02', weightKg: 61.234 },
      { date: '2026-09-03', weightKg: 59.876 },
    ],
    expected: { minKg: 59.88, maxKg: 61.23, meanKg: 60.56, latestKg: 59.88, changeKg: -0.68 },
  },
  {
    name: '★ 降序 + 超过 2 位小数（两条分歧同时命中）',
    points: [
      { date: '2026-09-03', weightKg: 59.876 },
      { date: '2026-09-01', weightKg: 60.555 },
      { date: '2026-09-02', weightKg: 61.234 },
    ],
    expected: { minKg: 59.88, maxKg: 61.23, meanKg: 60.56, latestKg: 59.88, changeKg: -0.68 },
  },
  {
    name: '浮点噪声（change = 0.1）',
    points: [
      { date: '2026-09-01', weightKg: 60.1 },
      { date: '2026-09-02', weightKg: 60.2 },
    ],
    expected: { minKg: 60.1, maxKg: 60.2, meanKg: 60.15, latestKg: 60.2, changeKg: 0.1 },
  },
  {
    name: '★ .005 取整边界（先相减后取整）',
    points: [
      { date: '2026-09-01', weightKg: 60 },
      { date: '2026-09-02', weightKg: 60.005 },
    ],
    expected: { minKg: 60, maxKg: 60.01, meanKg: 60, latestKg: 60.01, changeKg: 0.01 },
  },
  {
    name: '★ 超过 2 位小数且 min/max 落在中间点（不在首尾）',
    points: [
      { date: '2026-09-01', weightKg: 65 },
      { date: '2026-09-02', weightKg: 58.125 },
      { date: '2026-09-03', weightKg: 72.875 },
      { date: '2026-09-04', weightKg: 66 },
    ],
    expected: { minKg: 58.13, maxKg: 72.88, meanKg: 65.5, latestKg: 66, changeKg: 1 },
  },
];
