/**
 * 体重页「平台期说明卡」接线测试（pages/weight/WeightPage.tsx，R2.7）。
 *
 * 补上 `PlateauCard` 单测覆盖不到的那一层：**页面什么时候才把卡片渲染出来**。
 * - 连续 30 天 7 日均线纹丝不动 → 卡片出现（并解释判定依据）；
 * - 稳定下降 → 卡片不出现；
 * - 没有生效目标（goalProgress = null）→ 进度卡不出现（与 R2.6 `forecast: []` 同理）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { WeightTrendResponse } from '@qsh/shared-types';
import WeightPage from '@/pages/weight/WeightPage';
import { cacheClearAll } from '@/lib/local-cache';
import { clearPlateauVisibility } from '@/lib/plateau-visibility';
import { addDays, todayKey } from '@/lib/format';

/** 造一份「最近 30 天」的趋势响应（均线取同一个值，模拟后端算好的平滑序列）。 */
function payload(weightAt: (index: number) => number): WeightTrendResponse {
  const today = todayKey();
  const points = Array.from({ length: 30 }, (_, index) => ({
    date: addDays(today, -(29 - index)),
    weightKg: weightAt(index),
  }));
  return {
    points,
    movingAverage7: points.map((point) => ({ date: point.date, value: point.weightKg })),
    stats: { minKg: 58, maxKg: 70, latestKg: points[29]!.weightKg, changeKg: -2 },
    forecast: [],
    goalProgress: null,
  };
}

function renderWeightPage(data: WeightTrendResponse): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data, error: null }),
    })),
  );
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WeightPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('WeightPage 平台期卡片接线（R2.7）', () => {
  beforeEach(() => {
    cacheClearAll();
    // AC-11.1.6 的展示频控状态会跨用例残留 → 每个用例都从「从未展示 / 从未关闭」开始
    clearPlateauVisibility();
  });

  it('连续 30 天没变化 → 渲染平台期说明卡，并给出 4 周斜率视角', async () => {
    renderWeightPage(payload(() => 60));

    await waitFor(() => {
      expect(screen.getByText('这几周体重没怎么动')).toBeDefined();
    });
    // 判定依据与「拉长视角」都来自 @qsh/core 的纯函数结果
    expect(screen.getByText('最近 29 天，7 日均线的变化不到 0.3 kg')).toBeDefined();
    expect(screen.getByText('把时间拉到 4 周看，平均每周 0.00 kg')).toBeDefined();
  });

  it('稳定下降 → 不渲染平台期说明卡', async () => {
    renderWeightPage(payload((index) => 70 - index * (0.5 / 7)));

    await waitFor(() => {
      expect(screen.getByText('体重曲线与 7 日均线')).toBeDefined();
    });
    expect(screen.queryByText('这几周体重没怎么动')).toBeNull();
  });

  it('无生效目标（goalProgress = null）→ 目标进度卡不出现，不留空档', async () => {
    renderWeightPage(payload(() => 60));

    await waitFor(() => {
      expect(screen.getByText('体重曲线与 7 日均线')).toBeDefined();
    });
    expect(screen.queryByText('距离目标')).toBeNull();
    expect(screen.queryByText('已经到啦')).toBeNull();
  });
});
