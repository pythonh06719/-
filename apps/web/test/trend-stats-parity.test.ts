import {
  TREND_STATS_SHARED_CASES,
  computeTrendStats as coreCompute,
} from '@qsh/core';
import type { WeightTrendPoint } from '@qsh/shared-types';
import { describe, expect, it } from 'vitest';

import { computeTrendStats } from '@/lib/trend';

/**
 * **跨端一致性**（NFR-11）：前端 `lib/trend.ts` 的区间统计必须与 `@qsh/core` 真源
 * **逐值相等**，且与后端 `WeightsService.list().stats` 消费同一份共享用例集
 * （对侧见 `apps/api/test/trend-stats-parity.test.ts`）。
 *
 * 统一口径要点（以原前端实现为准）：读数一律 `round2`；最早 / 最晚**按日期**取，不按数组顺序。
 */

function toPoints(points: ReadonlyArray<{ date: string; weightKg: number }>): WeightTrendPoint[] {
  return points.map((point) => ({ date: point.date, weightKg: point.weightKg }));
}

describe('前端区间统计 = @qsh/core 真源（跨端一致性）', () => {
  for (const testCase of TREND_STATS_SHARED_CASES) {
    it(`共享用例 · ${testCase.name}`, () => {
      const actual = computeTrendStats(toPoints(testCase.points));
      // 1) 与共享基线逐值相等（钉死口径，防任意一侧改判据）
      expect(actual).toEqual(testCase.expected);
      // 2) 与真源逐值相等（钉死「前端确实在调真源」）
      expect(actual).toEqual(coreCompute(testCase.points));
    });
  }

  it('离线兜底时本地算的统计 = 真源，不会与后端算出两个答案', () => {
    const points = toPoints([
      { date: '2026-09-01', weightKg: 65.432 },
      { date: '2026-09-04', weightKg: 64.128 },
      { date: '2026-09-08', weightKg: 63.876 },
    ]);
    expect(computeTrendStats(points)).toEqual(coreCompute(points));
    // 读数取整：不吐 65.432
    expect(computeTrendStats(points).maxKg).toBe(65.43);
  });
});
