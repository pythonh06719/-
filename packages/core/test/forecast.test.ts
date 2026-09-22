/**
 * 目标达成预测曲线测试（`weight/forecast.ts`，R2.6）。
 *
 * 钉死契约：
 * - 每周一个点（含首尾共 `targetWeeks + 1` 个），相邻点相差 7 天；
 * - 匀速线性下降，首点 == 起始体重、末点 == 目标体重（精确，无浮点残留）；
 * - 日期为本地日粒度，跨月 / 跨年正确进位；
 * - 不可预测的边界（周数 ≤ 0 / 起始 ≤ 目标 / 任一非有限 / 非法日期）一律返回 `[]`。
 */

import { describe, expect, it } from 'vitest';

import { buildGoalForecast } from '../src/index';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 两次迭代间的日期差（天）。 */
function dayDiff(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;
}

describe('buildGoalForecast（R2.6 目标达成预测曲线）', () => {
  it('24 周 → 25 个点；末点精确等于目标；相邻相差 7 天', () => {
    const points = buildGoalForecast({
      startWeightKg: 100,
      targetWeightKg: 70,
      targetWeeks: 24,
      startDate: '2026-09-01',
    });

    expect(points).toHaveLength(25);
    expect(points[0]).toEqual({ date: '2026-09-01', weightKg: 100 });
    expect(points[points.length - 1]!.weightKg).toBe(70);

    for (let i = 1; i < points.length; i += 1) {
      expect(dayDiff(points[i - 1]!.date, points[i]!.date)).toBe(7);
    }
  });

  it('匀速线性：首周即降 (起始 − 目标) ÷ 周数', () => {
    const points = buildGoalForecast({
      startWeightKg: 100,
      targetWeightKg: 70,
      targetWeeks: 24,
      startDate: '2026-09-01',
    });

    // 每周 1.25kg（30 / 24）
    expect(points[1]!.weightKg).toBeCloseTo(98.75, 10);
    expect(points[12]!.weightKg).toBeCloseTo(85, 10);
    // 严格单调不升
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!.weightKg).toBeLessThanOrEqual(points[i - 1]!.weightKg);
    }
  });

  it('本地日粒度：跨月 / 跨年正确进位', () => {
    const points = buildGoalForecast({
      startWeightKg: 80,
      targetWeightKg: 76,
      targetWeeks: 4,
      startDate: '2026-12-20',
    });

    expect(points.map((point) => point.date)).toEqual([
      '2026-12-20',
      '2026-12-27',
      '2027-01-03',
      '2027-01-10',
      '2027-01-17',
    ]);
    expect(points[points.length - 1]!.weightKg).toBe(76);
  });

  it('边界：周数 ≤ 0 / 起始 ≤ 目标 → 空数组', () => {
    const base = { startWeightKg: 100, targetWeightKg: 70, startDate: '2026-09-01' };
    expect(buildGoalForecast({ ...base, targetWeeks: 0 })).toEqual([]);
    expect(buildGoalForecast({ ...base, targetWeeks: -3 })).toEqual([]);
    expect(buildGoalForecast({ ...base, startWeightKg: 70, targetWeightKg: 70, targetWeeks: 4 })).toEqual(
      [],
    );
    expect(buildGoalForecast({ ...base, startWeightKg: 65, targetWeightKg: 70, targetWeeks: 4 })).toEqual(
      [],
    );
  });

  it('边界：任一数值非有限 / 非法日期 → 空数组', () => {
    const base = { startWeightKg: 100, targetWeightKg: 70, targetWeeks: 4, startDate: '2026-09-01' };
    expect(buildGoalForecast({ ...base, startWeightKg: Number.NaN })).toEqual([]);
    expect(buildGoalForecast({ ...base, targetWeightKg: Number.POSITIVE_INFINITY })).toEqual([]);
    expect(buildGoalForecast({ ...base, targetWeeks: Number.NaN })).toEqual([]);
    expect(buildGoalForecast({ ...base, startDate: 'not-a-date' })).toEqual([]);
  });
});
