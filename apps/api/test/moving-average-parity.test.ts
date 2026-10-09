import { MOVING_AVERAGE_SHARED_CASES, computeMovingAverage7d } from '@qsh/core';
import type { MovingAverageInputPoint } from '@qsh/core';
import { describe, expect, it } from 'vitest';

import { WeightsService } from '../src/weights/weights.service';

/**
 * **跨端一致性**（NFR-11）：服务端 `WeightsService.list()` 的 `movingAverage7` 必须与
 * `@qsh/core` 真源**逐值相等**，且与前端 `lib/trend.ts` 消费同一份共享用例集
 * （对侧见 `apps/web/test/moving-average-parity.test.ts`）。
 *
 * 这里走的是**真实服务链路**（`list()` → Prisma 行 → `toWeightLog` → `movingAverage7`），
 * 只用最小 fake 顶掉 Prisma / UsersService，不复制任何公式。
 *
 * ⚠️ 本文件是**纯单元测试**（不像 `*.e2e.test.ts` 那样加载 `dist`），因此不需要先 `nest build`。
 */

/** 用最小 fake 构造 `WeightsService`（不走 Nest DI，故无需装饰器元数据）。 */
function makeWeightsService(rows: readonly MovingAverageInputPoint[]): WeightsService {
  const prisma = {
    weightLog: {
      findMany: async () =>
        rows.map((row, index) => ({
          id: index + 1,
          userId: 1,
          loggedAt: row.date,
          weightKg: row.weightKg,
          note: null,
          source: 'manual',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        })),
      findFirst: async () => null,
    },
    userGoal: { findUnique: async () => null },
    weightGoalHistory: { findFirst: async () => null },
  };
  const usersService = {
    getProfile: async () => ({ goal: null, budget: null }),
  };
  return new WeightsService(prisma as never, usersService as never);
}

describe('后端 movingAverage7 = @qsh/core 真源（跨端一致性）', () => {
  for (const testCase of MOVING_AVERAGE_SHARED_CASES) {
    it(`共享用例 · ${testCase.name}`, async () => {
      const service = makeWeightsService(testCase.points);
      const result = await service.list(1, 90);

      // 1) 与共享基线逐值相等（钉死口径，防任意一侧改判据）
      expect(result.movingAverage7).toEqual(testCase.expected);
      // 2) 与真源逐值相等（钉死「后端确实在调真源」）
      expect(result.movingAverage7).toEqual(computeMovingAverage7d(testCase.points));
      // 3) 与 `logs` 日期集合一致、升序（真源排序，故按升序后的 loggedAt 比对）
      expect(result.movingAverage7.map((point) => point.date)).toEqual(
        result.logs
          .map((log) => log.loggedAt)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    });
  }

  it('入参乱序时后端输出仍升序（不再依赖 Prisma 的 orderBy）', async () => {
    const service = makeWeightsService([
      { date: '2026-09-05', weightKg: 64 },
      { date: '2026-09-01', weightKg: 60 },
      { date: '2026-09-03', weightKg: 62 },
    ]);
    const result = await service.list(1, 90);
    expect(result.movingAverage7.map((point) => point.date)).toEqual([
      '2026-09-01',
      '2026-09-03',
      '2026-09-05',
    ]);
  });

  it('空区间 → 空均线（不臆造 0）', async () => {
    const service = makeWeightsService([]);
    const result = await service.list(1, 90);
    expect(result.movingAverage7).toEqual([]);
  });
});
