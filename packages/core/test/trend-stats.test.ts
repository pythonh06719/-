import { describe, expect, it } from 'vitest';

import {
  computeTrendStats,
  TREND_STATS_SHARED_CASES,
  type TrendStatsInputPoint,
} from '../src/weight/trend-stats';

/**
 * 区间统计真源单测（NFR-11 唯一口径）。
 *
 * 这里跑的 `TREND_STATS_SHARED_CASES` 与 `apps/api`、`apps/web` 的跨端用例**是同一份数据**，
 * 因此「服务端与前端统计一致」是被断言钉住的，不是注释承诺。
 */

describe('computeTrendStats（真源）', () => {
  it('共享用例集非空（防误删导致三处测试空跑）', () => {
    expect(TREND_STATS_SHARED_CASES.length).toBeGreaterThan(8);
  });

  for (const testCase of TREND_STATS_SHARED_CASES) {
    it(`共享用例 · ${testCase.name}`, () => {
      expect(computeTrendStats(testCase.points)).toEqual(testCase.expected);
    });
  }

  it('纯函数：不修改入参顺序', () => {
    const input: TrendStatsInputPoint[] = [
      { date: '2026-09-05', weightKg: 64 },
      { date: '2026-09-01', weightKg: 60 },
    ];
    const snapshot = [...input];
    computeTrendStats(input);
    expect(input).toEqual(snapshot);
  });

  it('空输入 → 五字段全 null，不是 0', () => {
    expect(computeTrendStats([])).toEqual({
      minKg: null,
      maxKg: null,
      meanKg: null,
      latestKg: null,
      changeKg: null,
    });
  });

  it('读数一律 round2：不吐三位小数', () => {
    // 58.125 → 58.13（不是 58.125）；72.875 → 72.88
    const result = computeTrendStats([
      { date: '2026-09-01', weightKg: 58.125 },
      { date: '2026-09-02', weightKg: 72.875 },
    ]);
    expect(result.minKg).toBe(58.13);
    expect(result.maxKg).toBe(72.88);
    expect(result.latestKg).toBe(72.88);
  });

  it('changeKg 取整发生在相减之后（不是先取整再相减）', () => {
    // 60.004 − 59.996 = 0.008 → 取整 0.01；若先取整则为 60 − 60 = 0
    const result = computeTrendStats([
      { date: '2026-09-01', weightKg: 59.996 },
      { date: '2026-09-02', weightKg: 60.004 },
    ]);
    expect(result.changeKg).toBe(0.01);
  });

  it('入参降序时 latestKg / changeKg 不翻转（按日期取最早最晚）', () => {
    const result = computeTrendStats([
      { date: '2026-09-03', weightKg: 64 },
      { date: '2026-09-02', weightKg: 62 },
      { date: '2026-09-01', weightKg: 60 },
    ]);
    expect(result.latestKg).toBe(64);
    expect(result.changeKg).toBe(4);
  });
});
