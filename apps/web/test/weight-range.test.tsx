/**
 * 体重区间视图测试（C4：近 7 / 30 / 90 天）。
 *
 * 分两层：
 * 1. **纯函数层**：`slicePointsByRange`（端点闭区间 / 窗口外排除）、`alignMovingAverage`（按日期对齐，
 *    缺失填 `null`）、`computeTrendStats`（min/max/均值只吃切片后的点）。
 * 2. **页面接线层**：`WeightPage` 默认 = 90 天；点击区间后图表数据点数与统计卡联动。
 *
 * 语气硬约束（PRD §7）：区间只是「把哪一段摊开看」，不评判、不催。
 *
 * 与 R2.6 的关系：本组测试只驱动 `WeightPage` 的**切片**行为，不触碰 `WeightChart` 的坐标轴逻辑；
 * R2.6 的 11 条守护在 `weight-chart.test.tsx`，此处不重复、不冲突。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { WeightTrendPoint, WeightTrendResponse } from '@qsh/shared-types';
import WeightPage from '@/pages/weight/WeightPage';
import { cacheClearAll } from '@/lib/local-cache';
import { addDays, todayKey } from '@/lib/format';
import {
  DEFAULT_WEIGHT_RANGE_DAYS,
  WEIGHT_RANGE_DAYS_OPTIONS,
  alignMovingAverage,
  computeTrendStats,
  slicePointsByRange,
} from '@/lib/trend';

/** 以「今天」为窗口右端，保证与页面切片基准一致（且时区安全）。 */
const TODAY = todayKey();

function point(date: string, weightKg: number): WeightTrendPoint {
  return { date, weightKg };
}

/** 造 `count` 天连续点（以 TODAY 结尾），体重 = 55 + 序号×0.5 kg（递增，便于验算 min/max/均值）。 */
function series(count: number): WeightTrendPoint[] {
  return Array.from({ length: count }, (_, index) =>
    point(addDays(TODAY, -(count - 1 - index)), 55 + index * 0.5),
  );
}

describe('slicePointsByRange（C4 区间切片纯函数）', () => {
  const points = series(96); // TODAY-95 .. TODAY

  it('区间端点闭区间：7 天 = 今天起往前 7 个自然日', () => {
    const sliced = slicePointsByRange(points, 7, TODAY);
    expect(sliced).toHaveLength(7);
    expect(sliced[0]?.date).toBe(addDays(TODAY, -6));
    expect(sliced[sliced.length - 1]?.date).toBe(TODAY);
  });

  it('30 / 90 天各自切出正确数量，且今天-90 落在 90 天窗口之外', () => {
    expect(slicePointsByRange(points, 30, TODAY)).toHaveLength(30);

    const slice90 = slicePointsByRange(points, 90, TODAY);
    expect(slice90).toHaveLength(90);
    expect(slice90[0]?.date).toBe(addDays(TODAY, -89));
    expect(slice90.some((item) => item.date === addDays(TODAY, -90))).toBe(false);
  });

  it('区间内点数不足 → 按实际返回（不补零、不外推）', () => {
    expect(slicePointsByRange(points, 200, TODAY)).toHaveLength(96);
    expect(slicePointsByRange([], 30, TODAY)).toHaveLength(0);
  });

  it('默认区间 = 90 天，可选项 = [7, 30, 90]', () => {
    expect(DEFAULT_WEIGHT_RANGE_DAYS).toBe(90);
    expect([...WEIGHT_RANGE_DAYS_OPTIONS]).toEqual([7, 30, 90]);
  });
});

describe('区间统计：computeTrendStats 吃切片后的点', () => {
  const points = series(96);

  it('近 7 天：min / max / 均值都只算该区间（i=89..95 → 99.5..102.5）', () => {
    const stats = computeTrendStats(slicePointsByRange(points, 7, TODAY));
    expect(stats.minKg).toBe(99.5);
    expect(stats.maxKg).toBe(102.5);
    expect(stats.meanKg).toBe(101);
  });

  it('近 30 天：区间放大后 min 更小、均值随之变化（i=66..95 → 88..102.5）', () => {
    const stats = computeTrendStats(slicePointsByRange(points, 30, TODAY));
    expect(stats.minKg).toBe(88);
    expect(stats.maxKg).toBe(102.5);
    expect(stats.meanKg).toBe(95.25);
  });
});

describe('alignMovingAverage（按日期对齐，缺失填 null）', () => {
  it('按日期取值；不在均线序列里的日期为 null（不臆造数值）', () => {
    const movingAverage = [
      { date: addDays(TODAY, -2), value: 60 },
      { date: addDays(TODAY, -1), value: null },
    ];
    const pts = [point(addDays(TODAY, -2), 61), point(addDays(TODAY, -1), 59), point(TODAY, 60)];
    expect(alignMovingAverage(movingAverage, pts)).toEqual([60, null, null]);
  });
});

// ---------------------------------------------------------------------------
// 页面接线
// ---------------------------------------------------------------------------

function payload(): WeightTrendResponse {
  const points = series(96);
  return {
    points,
    movingAverage7: points.map((item) => ({ date: item.date, value: item.weightKg })),
    stats: { minKg: 55, maxKg: 102.5, latestKg: 102.5, changeKg: 47.5 },
    forecast: [],
    goalProgress: null,
  };
}

function renderPage(data: WeightTrendResponse): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data, error: null }),
    })),
  );
  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WeightPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return container;
}

/** 取图表的无障碍标签（含「N 个数据点」）。 */
function chartLabel(container: HTMLElement): string {
  const charts = Array.from(container.querySelectorAll('svg[role="img"]'));
  const chart = charts.find((svg) => (svg.getAttribute('aria-label') ?? '').includes('数据点'));
  return chart?.getAttribute('aria-label') ?? '';
}

/** 读某个统计标签（最低 / 最高 / 均值 / 净变化）对应的数值。 */
function statValue(label: string): string {
  const dt = screen.getByText(label);
  return dt.parentElement?.querySelector('dd')?.textContent ?? '';
}

describe('WeightPage 区间接线（C4）', () => {
  beforeEach(() => {
    cacheClearAll();
    vi.unstubAllGlobals();
  });

  it('默认 90 天；切到 7 / 30 天后图表数据点数随之变化', async () => {
    const container = renderPage(payload());

    await waitFor(() => {
      expect(chartLabel(container)).toContain('90 个数据点');
    });

    fireEvent.click(screen.getByRole('button', { name: '近 7 天' }));
    await waitFor(() => {
      expect(chartLabel(container)).toContain('7 个数据点');
    });

    fireEvent.click(screen.getByRole('button', { name: '近 30 天' }));
    await waitFor(() => {
      expect(chartLabel(container)).toContain('30 个数据点');
    });
  });

  it('区间统计卡随区间联动：近 7 天最低 99.5 / 均值 101.0，默认不是这个值', async () => {
    renderPage(payload());

    await waitFor(() => {
      expect(statValue('最低')).toBe('58.0'); // 默认 90 天：58.0 .. 102.5
    });
    const defaultMean = statValue('均值');
    expect(defaultMean).not.toBe('101.0');

    fireEvent.click(screen.getByRole('button', { name: '近 7 天' }));
    await waitFor(() => {
      expect(statValue('最低')).toBe('99.5');
    });
    expect(statValue('均值')).toBe('101.0');
    expect(statValue('最高')).toBe('102.5');
  });

  it('三段范围按钮都在，且同一时刻只有一个是按下态', async () => {
    renderPage(payload());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '近 90 天' })).toBeDefined();
    });

    const buttons = WEIGHT_RANGE_DAYS_OPTIONS.map((days) =>
      screen.getByRole('button', { name: `近 ${days} 天` }),
    );
    expect(buttons).toHaveLength(3);
    expect(buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '近 90 天' }).getAttribute('aria-pressed')).toBe('true');
  });
});
