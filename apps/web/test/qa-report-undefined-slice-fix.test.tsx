import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PeriodReportView from '@/pages/report/PeriodReportView';
import WeeklyReportView from '@/pages/report/WeeklyReportView';
import { COPY } from '@/lib/copy';

/**
 * eng-report-fix —— Report 视图 **`from` / `to` / `day.date` 缺失** 的根因回归（GAP-10 的根因修复）。
 *
 * 背景：`qa-bcd4af4-report-defensive.test.tsx` 只覆盖了 `days` / `topHabits` / `micronutrients`
 * 的 map / length 路径；**未覆盖** 字符串字段缺失时 `.slice()` 的抛错路径。
 * 后端字段缺失（旧缓存 / 代理截断 / 测试桩通用返回）时：
 *   - `WeeklyReportView` L176 `report.from.slice(5)`、L239 `day.date.slice(5)`
 *   - `IntakeExerciseChart` L113 `day.date.slice(5)`（随 `<IntakeExerciseChart days={reportDays} />` 一同渲染）
 *   - `PeriodReportView` L114 `formatMonthDay(undefined)` → `parseDateKey(undefined)`
 * 都会**直接抛错**（`undefined.slice`）导致整页白屏，被 ErrorBoundary 兜成「这一页暂时打不开」。
 *
 * 本文件断言：字段缺失时视图**不抛错、不进 ErrorBoundary 兜底、仍渲染骨架**，区间文案优雅降级。
 * 兜底文案（`COPY.errorBoundaryTitle` =「这一页暂时打不开」）一旦出现即判失败。
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

/** ErrorBoundary 兜底标题不应出现（出现 = 组件被抛错打断，白屏被兜住）。 */
function expectNoBoundaryFallback(): void {
  expect(screen.queryByText(COPY.pageFallbackTitle)).toBeNull();
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('eng-report-fix · 周报 from/to/day.date 缺失不抛错', () => {
  it('weekly 响应缺 from / to → 不抛错，标题降级为中性「近 7 天（近 7 天）」，不进兜底', async () => {
    stubFetch([
      {
        match: '/api/report/weekly',
        payload: {
          // 刻意缺 from / to（确定的 undefined.slice 抛点）
          days: [
            { date: '2026-09-17', intakeKcal: 1500, exerciseKcal: 200, waterMl: 0, habitsDone: 0, habitsTotal: 0 },
            { date: '2026-09-18', intakeKcal: 1600, exerciseKcal: 100, waterMl: 0, habitsDone: 0, habitsTotal: 0 },
          ],
          avgIntakeKcal: 1550,
          totalExerciseKcal: 300,
          weightChangeKg: null,
          micronutrients: [],
          referenceNote: '参考《中国居民膳食营养素参考摄入量》。',
          distinctFoodCount: 0,
          distinctFoods: [],
          distinctFoodsTruncated: false,
        },
      },
    ]);
    renderWithQuery(<WeeklyReportView />);

    // 有记录（days 非空）→ 渲染指标 section，标题走中性降级
    await waitFor(() => expect(screen.getByText('近 7 天（近 7 天）')).toBeInTheDocument());
    expectNoBoundaryFallback();
    // 逐日列表仍渲染（不缺 date 的本次是好的；图表轴 + 明细列表各出现一次）
    expect(screen.getAllByText('09-17').length).toBeGreaterThan(0);
  });

  it('weekly 响应 days 元素缺 date（且有记录）→ 不抛错，逐日项降级为「—」，不进兜底', async () => {
    stubFetch([
      {
        match: '/api/report/weekly',
        payload: {
          from: '2026-09-17',
          to: '2026-09-23',
          days: [
            // 元素缺 date（确定在 WeeklyReportView L239 与 IntakeExerciseChart L113 双重抛点）
            { intakeKcal: 1500, exerciseKcal: 200, waterMl: 0, habitsDone: 0, habitsTotal: 0 },
          ],
          avgIntakeKcal: 1500,
          totalExerciseKcal: 200,
          weightChangeKg: null,
          micronutrients: [],
          referenceNote: 'x',
          distinctFoodCount: 0,
          distinctFoods: [],
          distinctFoodsTruncated: false,
        },
      },
    ]);
    renderWithQuery(<WeeklyReportView />);

    await waitFor(() => expect(screen.getByText('近 7 天（2026-09-17 ~ 2026-09-23）')).toBeInTheDocument());
    expectNoBoundaryFallback();
    // 缺 date 的逐日项降级为中性的「—」，而不是抛错 / 空白
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('weekly 响应 from/to 为非字符串（形态异常）→ 不抛错，仍渲染', async () => {
    stubFetch([
      {
        match: '/api/report/weekly',
        payload: {
          from: null,
          to: 20260923,
          days: [],
          avgIntakeKcal: 0,
          totalExerciseKcal: 0,
          weightChangeKg: null,
          micronutrients: [],
          referenceNote: 'x',
          distinctFoodCount: 0,
          distinctFoods: [],
          distinctFoodsTruncated: false,
        },
      },
    ]);
    renderWithQuery(<WeeklyReportView />);
    await waitFor(() => expect(screen.getByTestId('week-window-label')).toBeInTheDocument());
    expectNoBoundaryFallback();
  });
});

describe('eng-report-fix · 阶段回顾 from/to/weight 缺失不抛错', () => {
  it('period 响应缺 from / to → 不抛错，区间降级表述，指标列表仍渲染，不进兜底', async () => {
    stubFetch([
      {
        match: '/api/report/period',
        payload: {
          // 刻意缺 from / to（formatMonthDay(undefined) 的入口）
          days: 30,
          hasAnyData: true,
          loggedDays: 12,
          distinctFoodCount: 48,
          mealEntryCount: 102,
          winCount: 0,
          topHabits: [],
          exercise: { sessions: 0, totalMinutes: 0 },
          weight: null,
        },
      },
      { match: '/api/foods/top', payload: { days: 30, items: [] } },
    ]);
    renderWithQuery(<PeriodReportView />);

    await waitFor(() => expect(screen.getByTestId('period-metrics')).toBeInTheDocument());
    expectNoBoundaryFallback();
    // 区间降级为「近 30 天（这段时间暂时取不到具体日期）」，不显示 NaN / undefined
    expect(screen.getByTestId('period-range').textContent).toContain('近 30 天');
    expect(screen.getByTestId('period-range').textContent).not.toContain('NaN');
    expect(screen.getByTestId('period-range').textContent).not.toContain('undefined');
  });

  it('period 响应 weight 为非 null 非对象（字符串）→ 不抛错，体重块不渲染，不进兜底', async () => {
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
          topHabits: [],
          exercise: { sessions: 0, totalMinutes: 0 },
          weight: 'unexpected-shape', // 非 null 非对象
        },
      },
      { match: '/api/foods/top', payload: { days: 30, items: [] } },
    ]);
    renderWithQuery(<PeriodReportView />);

    await waitFor(() => expect(screen.getByTestId('period-metrics')).toBeInTheDocument());
    expectNoBoundaryFallback();
    // 形态异常 → 视为无体重变化，整块隐藏
    expect(screen.queryByTestId('period-weight')).toBeNull();
  });
});
