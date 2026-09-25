import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PeriodReportView from '@/pages/report/PeriodReportView';
import WeeklyReportView from '@/pages/report/WeeklyReportView';
import { COPY } from '@/lib/copy';

/**
 * QA 独立证伪（software-qa-engineer-4）—— C12 报表视图的**字段缺失防御**（无 ErrorBoundary）。
 *
 * 若视图对 `topHabits` / `exercise`（period）或 `days` / `micronutrients`（weekly）
 * 缺失时不设防，`undefined.length` / `undefined.map` 会抛错 → **整页白屏**。
 * 本文件直接喂「缺字段的响应」，断言仍能渲染出页面骨架（不崩、不空白）。
 */

function stubFetch(routes: Array<{ match: string; payload: unknown }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const hit = routes.find((route) => url.includes(route.match));
      if (hit === undefined) throw new Error(`测试桩未覆盖的请求：${url}`);
      return { ok: true, status: 200, json: async () => ({ data: hit.payload, error: null }) } as Response;
    }),
  );
}

function renderWithQuery(node: ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('QA · 阶段回顾字段缺失不白屏（C12）', () => {
  it('period 响应缺 topHabits / exercise / weight → 仍渲染指标列表，不崩溃', async () => {
    stubFetch([
      {
        match: '/api/report/period',
        payload: {
          from: '2026-08-25',
          to: '2026-09-23',
          days: 30,
          hasAnyData: true,
          loggedDays: 12,
          distinctFoodCount: 48,
          mealEntryCount: 102,
          winCount: 0,
          // 刻意缺 topHabits / exercise / weight
        },
      },
      { match: '/api/foods/top', payload: { days: 30, items: [] } },
    ]);
    renderWithQuery(<PeriodReportView />);

    await waitFor(() => expect(screen.getByTestId('period-metrics')).toBeInTheDocument());
    const items = screen.getByTestId('period-metrics').querySelectorAll('li');
    // ①②③ 恒显示；④⑤⑥ 因缺字段/为 0 而隐藏 → 恰好 3 句
    expect(items).toHaveLength(3);
    expect(screen.queryByTestId('period-weight')).toBeNull();
  });

  it('period 响应 topHabits 为非数组、exercise 缺失、weight=null → 不崩溃', async () => {
    stubFetch([
      {
        match: '/api/report/period',
        payload: {
          from: '2026-08-25',
          to: '2026-09-23',
          days: 30,
          hasAnyData: true,
          loggedDays: 1,
          distinctFoodCount: 1,
          mealEntryCount: 1,
          topHabits: { unexpected: true }, // 非数组（形态异常）
          // exercise 整字段缺失（字段缺失）
          weight: null, // 契约允许 null
          winCount: 0,
        },
      },
      { match: '/api/foods/top', payload: { days: 30, items: null } },
    ]);
    renderWithQuery(<PeriodReportView />);
    await waitFor(() => expect(screen.getByTestId('period-metrics')).toBeInTheDocument());
  });
});

describe('QA · 周报字段缺失不白屏（C12）', () => {
  it('weekly 响应缺 days / micronutrients → 仍渲染骨架，不崩溃', async () => {
    stubFetch([
      {
        match: '/api/report/weekly',
        payload: {
          from: '2026-09-17',
          to: '2026-09-23',
          avgIntakeKcal: 1500,
          totalExerciseKcal: 200,
          weightChangeKg: null,
          referenceNote: '参考《中国居民膳食营养素参考摄入量》。',
          distinctFoodCount: 0,
          // 刻意缺 days / micronutrients / distinctFoods
        },
      },
    ]);
    renderWithQuery(<WeeklyReportView />);

    await waitFor(() => expect(screen.getByText('近 7 天（2026-09-17 ~ 2026-09-23）')).toBeInTheDocument());
    // 缺 days → 习惯达成率 fallback 到中性文案，而非 NaN / 崩溃
    expect(screen.getByText(COPY.reportHabitEmpty)).toBeInTheDocument();
    // 微量营养素空列表：标题仍在
    expect(screen.getByText('微量营养素（日均）')).toBeInTheDocument();
  });

  it('weekly 响应 days / micronutrients 为 null（非数组）→ 不崩溃', async () => {
    stubFetch([
      {
        match: '/api/report/weekly',
        payload: {
          from: '2026-09-17',
          to: '2026-09-23',
          days: null,
          micronutrients: null,
          avgIntakeKcal: 0,
          totalExerciseKcal: 0,
          weightChangeKg: null,
          referenceNote: 'x',
          distinctFoodCount: 0,
          distinctFoods: null,
        },
      },
    ]);
    renderWithQuery(<WeeklyReportView />);
    await waitFor(() => expect(screen.getByText('近 7 天（2026-09-17 ~ 2026-09-23）')).toBeInTheDocument());
  });
});
