import { MOVING_AVERAGE_SHARED_CASES, computeMovingAverage7d as coreCompute } from '@qsh/core';
import type { WeightTrendPoint } from '@qsh/shared-types';
import { describe, expect, it } from 'vitest';

import { computeMovingAverage7d } from '@/lib/trend';

/**
 * **跨端一致性**（NFR-11）：前端 `lib/trend.ts` 的 7 日移动平均必须与 `@qsh/core` 真源
 * **逐值相等**，且与后端 `WeightsService.list()` 消费同一份共享用例集
 * （对侧见 `apps/api/test/moving-average-parity.test.ts`）。
 *
 * 这些用例此前只是 `trend.ts` 里一句「两者算法保持一致」的注释承诺；现在任一端的本地实现
 * 若漂移（例如缺天时分母误用 7），本文件立刻变红。
 */

function toPoints(points: ReadonlyArray<{ date: string; weightKg: number }>): WeightTrendPoint[] {
  return points.map((point) => ({ date: point.date, weightKg: point.weightKg }));
}

describe('前端移动平均 = @qsh/core 真源（跨端一致性）', () => {
  for (const testCase of MOVING_AVERAGE_SHARED_CASES) {
    it(`共享用例 · ${testCase.name}`, () => {
      const actual = computeMovingAverage7d(toPoints(testCase.points));
      // 1) 与共享基线逐值相等（钉死口径，防任意一侧改判据）
      expect(actual).toEqual(testCase.expected);
      // 2) 与真源逐值相等（钉死「前端确实在调真源」）
      expect(actual).toEqual(coreCompute(testCase.points));
    });
  }

  it('后端不可用时前端本地兜底 → 与后端同源，不会算出两个数字', () => {
    const points = toPoints([
      { date: '2026-09-01', weightKg: 65.4 },
      { date: '2026-09-04', weightKg: 64.8 },
      { date: '2026-09-08', weightKg: 64.1 },
    ]);
    expect(computeMovingAverage7d(points)).toEqual(coreCompute(points));
  });
});
