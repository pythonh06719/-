/**
 * 体重 **7 日移动平均**的唯一真源（NFR-11 / R7.2）。
 *
 * 背景：此前服务端（`apps/api/src/weights/weights.service.ts` 的私有 `averageWindow`）与
 * 前端（`apps/web/src/lib/trend.ts` 的 `computeMovingAverage7d`）各有一份实现，只靠注释承诺
 * 「两者算法保持一致」，没有任何用例钉住。这里把判据收敛为一份纯函数，两侧都改调它。
 *
 * **口径（改动前后完全一致，本次是重构不是改口径）**：
 * - 窗口 = **以该记录日为终点、往前 7 个自然日（含当日）**的日历窗口，`[date-6, date]`；
 *   不是「最近 7 条记录」；
 * - **缺天**：分母是窗口内**已有的记录条数**，不是 7（不补零、不外推）；
 * - **不足 7 天**（前 6 天）：照算，首日 = 首日体重；
 * - **同一天多条记录**：全部计入窗口（历史脏数据也不会被静默丢掉），输出保留重复日期；
 * - **取整**：`sum / count` 求完再 `round2`（`Math.round(v*100)/100`），不在每一步取整；
 * - **排序**：输出按日期升序，与输入顺序无关（服务端原本依赖 Prisma 的 `orderBy`，
 *   这里显式排序，对既有升序输入是恒等变换）。
 *
 * ⚠️ 输入日期键须为严格 `YYYY-MM-DD`（`logged_at` 由 DTO 的 `@IsLocalDateKey()` 保证，
 * 日期键一律由 `toLocalDateKey` 生成，均满足）。非严格形态下 `shiftLocalDateKey` 原样返回，
 * 窗口会退化 —— 这是刻意的「不猜输入」，生产链路不可达。
 */

import { round2 } from '../calorie/rounding';
import { shiftLocalDateKey } from '../date/daykey';

/** 移动平均窗口长度（自然日，含当日）。契约字段名 `movingAverage7` 由此得名，不可改。 */
export const MOVING_AVERAGE_WINDOW_DAYS = 7;

/** 输入点：任意 `{ date, weightKg }`（`WeightTrendPoint` / `WeightLog` 均结构兼容）。 */
export interface MovingAverageInputPoint {
  /** `YYYY-MM-DD` */
  date: string;
  /** 体重 kg */
  weightKg: number;
}

/** 输出点：与 `shared-types` 的 `MovingAveragePoint` 结构一致（此处不 import 契约包）。 */
export interface MovingAverageOutputPoint {
  /** `YYYY-MM-DD` */
  date: string;
  /** 窗口均值 kg；窗口内无任何记录时为 `null`（图表按断点处理，不臆造 0）。 */
  value: number | null;
}

/**
 * 计算 7 日移动平均线。
 *
 * @param points 原始体重点（任意顺序，函数内部按日期升序排序；不修改入参）
 * @returns 与输入点一一对应的移动平均点（升序）
 */
export function computeMovingAverage7d(
  points: readonly MovingAverageInputPoint[],
): MovingAverageOutputPoint[] {
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return sorted.map((point) => {
    const windowStart = shiftLocalDateKey(point.date, -(MOVING_AVERAGE_WINDOW_DAYS - 1));
    let sum = 0;
    let count = 0;
    for (const candidate of sorted) {
      if (candidate.date >= windowStart && candidate.date <= point.date) {
        sum += candidate.weightKg;
        count += 1;
      }
    }
    // 按「已有条数」为分母：缺天不补零，不足 7 天不外推
    return { date: point.date, value: count === 0 ? null : round2(sum / count) };
  });
}

// ---------------------------------------------------------------------------
// 跨端一致性基线（NFR-11）
// ---------------------------------------------------------------------------

/** 一条共享边界用例（输入 + 期望输出），供 `core` / `apps/api` / `apps/web` 三处测试共用。 */
export interface MovingAverageSharedCase {
  /** 用例名（出现在测试报告里，便于定位） */
  name: string;
  /** 输入体重点（刻意含乱序 / 重复日期等脏形态） */
  points: MovingAverageInputPoint[];
  /** 期望输出：与输入日期对齐、升序、`value` 逐值相等 */
  expected: MovingAverageOutputPoint[];
}

/**
 * **共享边界用例集** —— 把「服务端与前端算法一致」从注释变成断言。
 *
 * ⚠️ **为什么这份「测试基线」放在 `src`（prod 导出面）而不是 `test/fixtures`：**
 * `@qsh/core` 的 `exports` 只暴露 `src`，若放到 `test/` 下，`apps/api` 与 `apps/web` 两侧
 * 就只能靠跨包相对路径去够另一个包的测试目录（无先例且脆，目录一挪就断）。
 * 放在这里换三处都能稳定 import 同一份数据 —— **这是有意为之，请不要当「误放」搬走**。
 * 代价是纯数据进了导出面（无逻辑、体量很小）。
 *
 * 覆盖：空数组、单条、不足 7 天、恰好 7 天、超过 7 天（滑动）、缺天（分母 = 已有条数）、
 * 跨月、闰年、小数与 `.005` 取整边界、浮点噪声、同日重复、输入乱序。
 *
 * 三处测试（core 单测 / api service / web trend）都跑这同一份数据并断言逐值相等；
 * 任何一侧退回自己的本地实现或改动某个边界，都会立刻变红。
 *
 * ⚠️ 这些期望值就是**当前线上口径**的快照：要改判据，必须先改这里，并确认是有意为之
 * （改动会让用户已经看到的数字变化）。
 */
export const MOVING_AVERAGE_SHARED_CASES: readonly MovingAverageSharedCase[] = [
  {
    name: '空数组 → 空结果',
    points: [],
    expected: [],
  },
  {
    name: '单条 → 均值即自身',
    points: [{ date: '2026-09-01', weightKg: 60 }],
    expected: [{ date: '2026-09-01', value: 60 }],
  },
  {
    name: '不足 7 天（3 天）→ 用窗口内已有点求平均，不补零',
    points: [
      { date: '2026-09-01', weightKg: 60 },
      { date: '2026-09-02', weightKg: 62 },
      { date: '2026-09-03', weightKg: 64 },
    ],
    expected: [
      { date: '2026-09-01', value: 60 },
      { date: '2026-09-02', value: 61 },
      { date: '2026-09-03', value: 62 },
    ],
  },
  {
    name: '恰好 7 天 → 末点为全部 7 点均值',
    points: ['01', '02', '03', '04', '05', '06', '07'].map((day, index) => ({
      date: `2026-09-${day}`,
      weightKg: 50 + index,
    })),
    expected: ['01', '02', '03', '04', '05', '06', '07'].map((day, index) => ({
      date: `2026-09-${day}`,
      value: 50 + index / 2,
    })),
  },
  {
    name: '缺天（09-01 与 09-10 相距 9 天）→ 各自窗口内只有自己',
    points: [
      { date: '2026-09-01', weightKg: 70 },
      { date: '2026-09-10', weightKg: 68 },
    ],
    expected: [
      { date: '2026-09-01', value: 70 },
      { date: '2026-09-10', value: 68 },
    ],
  },
  {
    name: '★ 7 天窗口内只有 3 条 → 分母必须是 3 而不是 7',
    points: [
      { date: '2026-09-01', weightKg: 60 },
      { date: '2026-09-03', weightKg: 62 },
      { date: '2026-09-07', weightKg: 64 },
    ],
    expected: [
      { date: '2026-09-01', value: 60 },
      { date: '2026-09-03', value: 61 },
      { date: '2026-09-07', value: 62 },
    ],
  },
  {
    name: '超过 7 天 → 窗口按自然日滑动（只含最近 7 个自然日）',
    points: Array.from({ length: 10 }, (_, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      weightKg: 60 + index * 0.35,
    })),
    expected: [
      { date: '2026-09-01', value: 60 },
      { date: '2026-09-02', value: 60.18 },
      { date: '2026-09-03', value: 60.35 },
      { date: '2026-09-04', value: 60.53 },
      { date: '2026-09-05', value: 60.7 },
      { date: '2026-09-06', value: 60.88 },
      { date: '2026-09-07', value: 61.05 },
      { date: '2026-09-08', value: 61.4 },
      { date: '2026-09-09', value: 61.75 },
      { date: '2026-09-10', value: 62.1 },
    ],
  },
  {
    name: '小数求和后取整（不是每步取整）',
    points: [
      { date: '2026-09-01', weightKg: 60.01 },
      { date: '2026-09-02', weightKg: 60.02 },
      { date: '2026-09-03', weightKg: 60.02 },
    ],
    expected: [
      { date: '2026-09-01', value: 60.01 },
      { date: '2026-09-02', value: 60.02 },
      { date: '2026-09-03', value: 60.02 },
    ],
  },
  {
    name: '★ .005 取整边界 → 四舍五入到分（不是截断）',
    points: [
      { date: '2026-09-01', weightKg: 60 },
      { date: '2026-09-02', weightKg: 60.01 },
    ],
    expected: [
      { date: '2026-09-01', value: 60 },
      { date: '2026-09-02', value: 60.01 },
    ],
  },
  {
    name: '浮点噪声（0.1 类）→ 求和后再取整，末位不抖',
    points: [
      { date: '2026-09-01', weightKg: 58.1 },
      { date: '2026-09-02', weightKg: 58.2 },
      { date: '2026-09-03', weightKg: 58.3 },
    ],
    expected: [
      { date: '2026-09-01', value: 58.1 },
      { date: '2026-09-02', value: 58.15 },
      { date: '2026-09-03', value: 58.2 },
    ],
  },
  {
    name: '同日重复记录（历史脏数据）→ 全部计入窗口，不静默丢点',
    points: [
      { date: '2026-09-01', weightKg: 60 },
      { date: '2026-09-01', weightKg: 70 },
      { date: '2026-09-02', weightKg: 65 },
    ],
    expected: [
      { date: '2026-09-01', value: 65 },
      { date: '2026-09-01', value: 65 },
      { date: '2026-09-02', value: 65 },
    ],
  },
  {
    name: '输入乱序 → 输出仍按日期升序',
    points: [
      { date: '2026-09-05', weightKg: 64 },
      { date: '2026-09-01', weightKg: 60 },
      { date: '2026-09-03', weightKg: 62 },
    ],
    expected: [
      { date: '2026-09-01', value: 60 },
      { date: '2026-09-03', value: 61 },
      { date: '2026-09-05', value: 62 },
    ],
  },
  {
    name: '跨月（09-30 → 10-03）→ 窗口跨月边界正确',
    points: [
      { date: '2026-09-30', weightKg: 61.5 },
      { date: '2026-10-01', weightKg: 61.2 },
      { date: '2026-10-03', weightKg: 60.8 },
    ],
    expected: [
      { date: '2026-09-30', value: 61.5 },
      { date: '2026-10-01', value: 61.35 },
      { date: '2026-10-03', value: 61.17 },
    ],
  },
  {
    name: '闰年（2028-02-29）→ 2 月 29 日参与窗口',
    points: [
      { date: '2028-02-27', weightKg: 70.2 },
      { date: '2028-02-28', weightKg: 70.0 },
      { date: '2028-02-29', weightKg: 69.8 },
      { date: '2028-03-01', weightKg: 69.6 },
      { date: '2028-03-02', weightKg: 69.4 },
    ],
    expected: [
      { date: '2028-02-27', value: 70.2 },
      { date: '2028-02-28', value: 70.1 },
      { date: '2028-02-29', value: 70 },
      { date: '2028-03-01', value: 69.9 },
      { date: '2028-03-02', value: 69.8 },
    ],
  },
];
