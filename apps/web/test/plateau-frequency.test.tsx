/**
 * 平台期卡展示频控接线测试（pages/weight/WeightPage.tsx，AC-11.1.6）。
 *
 * 钉死 PRD AC-11.1.6 的三段行为（都在**页面这一层**，因为闸门在 WeightPage）：
 * - **首次进入可见**，并把「今天已展示」写进本机；
 * - **同一天再次进入不可见**（同一天最多展示一次）；点「收起」→ 立即隐藏 + 写入关闭时间戳，
 *   随后**重新进入 7 天内不可见**；
 * - 关闭**已满 7 天**（预置 8 天前的时间戳）→ 可再次显示；
 * - **非平台期 → 永不显示**，且不写「已展示」（没展示就不该记）。
 *
 * 频控只压制展示，不改变 `detectWeightPlateau()` 的判定 —— 被压制时页面其余内容（含全量曲线）
 * 照常渲染，可由此确认「没被误当成没有数据」。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { WeightTrendResponse } from '@qsh/shared-types';
import WeightPage from '@/pages/weight/WeightPage';
import { cacheClearAll } from '@/lib/local-cache';
import { addDays, todayKey } from '@/lib/format';
import { COPY } from '@/lib/copy';
import { PLATEAU_DISMISSED_AT_KEY, PLATEAU_LAST_SHOWN_KEY } from '@/lib/plateau-visibility';

/** 平台期卡的标题（`detectWeightPlateau` 命中时才会出现）。 */
const PLATEAU_TITLE = '这几周体重没怎么动';
/** 数据已加载的信号：区间说明里会写「共 N 笔记录」。 */
const LOADED = /共 30 笔记录/;

/** 最近 30 天体重纹丝不动 → 平台期。 */
function plateauPayload(): WeightTrendResponse {
  const today = todayKey();
  const points = Array.from({ length: 30 }, (_, index) => ({
    date: addDays(today, -(29 - index)),
    weightKg: 60,
  }));
  return {
    points,
    movingAverage7: points.map((point) => ({ date: point.date, value: point.weightKg })),
    stats: { minKg: 60, maxKg: 60, latestKg: 60, changeKg: 0 },
    forecast: [],
    goalProgress: null,
  };
}

/** 最近 30 天稳定下降 → 非平台期。 */
function decliningPayload(): WeightTrendResponse {
  const today = todayKey();
  const points = Array.from({ length: 30 }, (_, index) => ({
    date: addDays(today, -(29 - index)),
    weightKg: 70 - index * (0.5 / 7),
  }));
  return {
    points,
    movingAverage7: points.map((point) => ({ date: point.date, value: point.weightKg })),
    stats: { minKg: 68, maxKg: 70, latestKg: 68, changeKg: -2 },
    forecast: [],
    goalProgress: null,
  };
}

/** 挂载一次 `/weight`（返回 render 句柄，便于 unmount 后模拟「重新进入」）。 */
function renderPage(data: WeightTrendResponse): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data, error: null }),
    })),
  );
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WeightPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('WeightPage 平台期卡频控（AC-11.1.6）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    cacheClearAll();
    vi.unstubAllGlobals();
  });

  it('首次进入可见，并写入「今天已展示」', async () => {
    renderPage(plateauPayload());

    await waitFor(() => {
      expect(screen.getByText(PLATEAU_TITLE)).toBeDefined();
    });
    expect(window.localStorage.getItem(PLATEAU_LAST_SHOWN_KEY)).toBe(todayKey());
  });

  it('同一天再次进入 → 不可见（同一天最多展示一次）', async () => {
    const first = renderPage(plateauPayload());
    await waitFor(() => {
      expect(screen.getByText(PLATEAU_TITLE)).toBeDefined();
    });

    first.unmount();
    renderPage(plateauPayload());

    // 等数据确实加载（全量曲线仍在）后，确认卡片没出现
    await waitFor(() => {
      expect(screen.getByText(LOADED)).toBeDefined();
    });
    expect(screen.queryByText(PLATEAU_TITLE)).toBeNull();
  });

  it('点「收起」→ 立即隐藏并写入关闭时间戳；重新进入 7 天内不可见', async () => {
    const first = renderPage(plateauPayload());
    await waitFor(() => {
      expect(screen.getByText(PLATEAU_TITLE)).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: COPY.plateauDismissAria }));

    // 立即隐藏 + 落库
    expect(screen.queryByText(PLATEAU_TITLE)).toBeNull();
    const dismissedAt = window.localStorage.getItem(PLATEAU_DISMISSED_AT_KEY);
    expect(dismissedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(dismissedAt ?? ''))).toBe(false);

    // 重新进入（仍在 7 天内）→ 不可见
    first.unmount();
    renderPage(plateauPayload());
    await waitFor(() => {
      expect(screen.getByText(LOADED)).toBeDefined();
    });
    expect(screen.queryByText(PLATEAU_TITLE)).toBeNull();
  });

  it('关闭已满 7 天（预置 8 天前的时间戳）→ 可再次显示', async () => {
    const eightDaysAgo = new Date();
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
    window.localStorage.setItem(PLATEAU_DISMISSED_AT_KEY, eightDaysAgo.toISOString());

    renderPage(plateauPayload());

    await waitFor(() => {
      expect(screen.getByText(PLATEAU_TITLE)).toBeDefined();
    });
  });

  it('非平台期 → 永不显示，且不写「已展示」', async () => {
    renderPage(decliningPayload());

    await waitFor(() => {
      expect(screen.getByText(LOADED)).toBeDefined();
    });
    expect(screen.queryByText(PLATEAU_TITLE)).toBeNull();
    // 没展示过就不该记录（避免把「非平台期」误记成「今天已展示」）
    expect(window.localStorage.getItem(PLATEAU_LAST_SHOWN_KEY)).toBeNull();
  });

  it('被频控压制时，页面其余内容照常渲染（频控不改判定、不丢数据）', async () => {
    window.localStorage.setItem(PLATEAU_LAST_SHOWN_KEY, todayKey());

    renderPage(plateauPayload());

    await waitFor(() => {
      expect(screen.getByText(LOADED)).toBeDefined();
    });
    // 卡片被压制，但全量曲线与统计仍在
    expect(screen.queryByText(PLATEAU_TITLE)).toBeNull();
    expect(screen.getByText('体重曲线与 7 日均线')).toBeDefined();
  });
});
