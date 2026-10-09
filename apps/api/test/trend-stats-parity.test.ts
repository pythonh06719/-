import { TREND_STATS_SHARED_CASES, computeTrendStats } from '@qsh/core';
import type { TrendStatsInputPoint } from '@qsh/core';
import { describe, expect, it } from 'vitest';

import { WeightsService } from '../src/weights/weights.service';

/**
 * **跨端一致性**（NFR-11）：服务端 `WeightsService.list().stats` 必须与 `@qsh/core` 真源
 * **逐值相等**，且与前端 `lib/trend.ts` 消费同一份共享用例集
 * （对侧见 `apps/web/test/trend-stats-parity.test.ts`）。
 *
 * 这里走的是**真实服务链路**（`list()` → Prisma 行 → `toWeightLog` → `stats`），
 * 只用最小 fake 顶掉 Prisma / UsersService，不复制任何公式。
 *
 * ⚠️ 契约 `WeightListResult.stats` 只有四字段（**无 `meanKg`**），故这里比四项；
 * 真源返回的 `meanKg` 不进契约，字段名与 shared-types 一致、未改动。
 *
 * ⚠️ 本文件是**纯单元测试**（不像 `*.e2e.test.ts` 那样加载 `dist`），不需要先 `nest build`。
 */

/** 用最小 fake 构造 `WeightsService`（不走 Nest DI，故无需装饰器元数据）。 */
function makeWeightsService(rows: readonly TrendStatsInputPoint[]): WeightsService {
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

/** 按契约投影：真源五字段 → `stats` 四字段（去掉 `meanKg`）。 */
function contractStats(stats: {
  minKg: number | null;
  maxKg: number | null;
  meanKg: number | null;
  latestKg: number | null;
  changeKg: number | null;
}): { minKg: number | null; maxKg: number | null; latestKg: number | null; changeKg: number | null } {
  return {
    minKg: stats.minKg,
    maxKg: stats.maxKg,
    latestKg: stats.latestKg,
    changeKg: stats.changeKg,
  };
}

describe('后端 stats = @qsh/core 真源（跨端一致性）', () => {
  for (const testCase of TREND_STATS_SHARED_CASES) {
    it(`共享用例 · ${testCase.name}`, async () => {
      const service = makeWeightsService(testCase.points);
      const result = await service.list(1, 90);

      // 1) 与共享基线逐值相等（钉死口径，防任意一侧改判据）
      expect(result.stats).toEqual(contractStats(testCase.expected));
      // 2) 与真源逐值相等（钉死「后端确实在调真源」）
      expect(result.stats).toEqual(contractStats(computeTrendStats(testCase.points)));
    });
  }

  it('★ 读数必须取整：不能吐三位小数（原后端不取整）', async () => {
    const service = makeWeightsService([
      { date: '2026-09-01', weightKg: 60.555 },
      { date: '2026-09-02', weightKg: 61.234 },
      { date: '2026-09-03', weightKg: 59.876 },
    ]);
    const result = await service.list(1, 90);
    expect(result.stats.minKg).toBe(59.88); // 不是 59.876
    expect(result.stats.maxKg).toBe(61.23); // 不是 61.234
    expect(result.stats.latestKg).toBe(59.88); // 不是 59.876
    expect(result.stats.changeKg).toBe(-0.68);
  });

  it('★ 入参降序时 latestKg / changeKg 不翻转（按日期取最早最晚）', async () => {
    const service = makeWeightsService([
      { date: '2026-09-03', weightKg: 64 },
      { date: '2026-09-02', weightKg: 62 },
      { date: '2026-09-01', weightKg: 60 },
    ]);
    const result = await service.list(1, 90);
    // 原后端按数组顺序会得到 latestKg=60 / changeKg=-4
    expect(result.stats.latestKg).toBe(64);
    expect(result.stats.changeKg).toBe(4);
  });

  it('空区间 → 四字段全 null（不臆造 0）', async () => {
    const service = makeWeightsService([]);
    const result = await service.list(1, 90);
    expect(result.stats).toEqual({ minKg: null, maxKg: null, latestKg: null, changeKg: null });
  });
});
