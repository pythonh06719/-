/**
 * 阶段回顾页测试（R11.3，pages/report/PeriodReportView.tsx + ReportPage tab 外壳）。
 *
 * 三个红线在这里**自动化封口**（QA 证伪口径）：
 * 1. **白名单**（AC-11.3.2）：页面只渲染 `PeriodReport` 白名单 6 类指标的陈述句，
 *    组件不得自造指标；
 * 2. **禁评分词汇黑名单**：`失败|缺失|缺席|未记录|断签|最长连续|连续记录|完成率|完成度|达成率`
 *    不得出现在阶段回顾视图的任何 DOM 里（K26）；
 * 3. **禁分数式 / 百分比**：正则 `/\d+\s*\/\s*\d+/` 与 `%` 不得出现 —— 有分母就会被读成完成度。
 *
 * 另覆盖：整屏空态（AC-11.3.5）、体重 null 整块隐藏（QR-4）、Top5 复用 `/foods/top`（D-4）、
 * 档位切换 30/365（QR-3）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ReportPage from '@/pages/report/ReportPage';
import { formatMonthDay } from '@/lib/format';
import {
  COPY,
  periodDayOptionLabel,
  periodDistinctLine,
  periodExerciseLine,
  periodHabitsLine,
  periodLoggedDaysLine,
  periodMealEntryLine,
  periodRangeLine,
  periodTopDaysText,
  periodWeightDownLine,
  periodWinCountLine,
} from '@/lib/copy';

/** 评分语义黑名单（K26 / AC-11.3.3）—— 阶段回顾视图一个都不许出现。 */
const BANNED_WORDS = [
  '失败',
  '缺失',
  '缺席',
  '未记录',
  '断签',
  '最长连续',
  '连续记录',
  '完成率',
  '完成度',
  '达成率',
];

/** 分数式：`3/7`、`3 / 7` 一律视为分母泄漏。 */
const FRACTION_PATTERN = /\d+\s*\/\s*\d+/;

/** 周报最小响应（阶段回顾测试里只作为默认 tab 的挂载数据，不参与断言）。 */
const weeklyPayload = {
  from: '2026-09-17',
  to: '2026-09-23',
  days: [],
  avgIntakeKcal: 0,
  totalExerciseKcal: 0,
  weightChangeKg: null,
  micronutrients: [],
  referenceNote: '参考《中国居民膳食营养素参考摄入量》。',
  distinctFoodCount: 0,
  distinctFoods: [],
  distinctFoodsTruncated: false,
};

/** 阶段回顾响应构造器（白名单 6 类全有值）。 */
function periodPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: '2026-08-25',
    to: '2026-09-23',
    days: 30,
    hasAnyData: true,
    loggedDays: 12,
    distinctFoodCount: 48,
    mealEntryCount: 102,
    topHabits: [{ habitId: 1, name: '喝水', count: 41 }],
    exercise: { sessions: 12, totalMinutes: 360 },
    weight: { startKg: 70, endKg: 67.7, deltaKg: -2.3 },
    winCount: 5,
    ...overrides,
  };
}

/** Top5（`GET /foods/top`）响应构造器。 */
function topPayload(items: Array<{ name: string; dayCount: number }>): Record<string, unknown> {
  return {
    days: 30,
    items: items.map((item) => ({ ...item, foodItemId: null, food: null })),
  };
}

interface FetchCall {
  url: string;
  method: string;
}

/**
 * 按 URL 前缀路由的 fetch 桩。
 * 返回 fetch 调用记录，供「Top5 复用 /foods/top」「空态不发请求」等断言使用。
 */
function stubFetch(routes: Array<{ match: string; payload: unknown }>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, method: init?.method ?? 'GET' });
      const hit = routes.find((route) => url.includes(route.match));
      if (hit === undefined) {
        throw new Error(`测试桩未覆盖的请求：${url}`);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: hit.payload, error: null }),
      } as Response;
    }),
  );
  return calls;
}

/** 渲染回顾页（挂载后默认 tab = 本周，K27）。 */
function renderReportPage(): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ReportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  ).container;
}

/** 点击「这段时间」tab 并等待阶段回顾渲染完成。 */
async function openPeriodTab(): Promise<void> {
  fireEvent.click(screen.getByRole('tab', { name: COPY.reportTabPeriod }));
  await waitFor(() => {
    expect(screen.getByTestId('period-metrics')).toBeDefined();
  });
}

describe('ReportPage tab 外壳（R11.3）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('默认 tab 是「本周」且挂载即发周报查询；切到「这段时间」才发 period 查询（K27）', async () => {
    const calls = stubFetch([
      { match: '/api/report/weekly', payload: weeklyPayload },
      { match: '/api/report/period', payload: periodPayload() },
      { match: '/api/foods/top', payload: topPayload([]) },
    ]);
    renderReportPage();

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/api/report/weekly'))).toBe(true);
    });
    // 默认 tab 下不得提前发 period 查询
    expect(calls.some((call) => call.url.includes('/api/report/period'))).toBe(false);

    await openPeriodTab();
    expect(calls.some((call) => call.url.includes('/api/report/period'))).toBe(true);
  });
});

describe('阶段回顾白名单与反评判红线（R11.3）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('六类白名单指标各渲染一句陈述句，权重句精确等于 copy 函数产物', async () => {
    stubFetch([
      { match: '/api/report/weekly', payload: weeklyPayload },
      { match: '/api/report/period', payload: periodPayload() },
      { match: '/api/foods/top', payload: topPayload([]) },
    ]);
    renderReportPage();
    await openPeriodTab();

    // 区间说明
    expect(
      screen.getByText(periodRangeLine(30, '2026-08-25', '2026-09-23', formatMonthDay)),
    ).toBeDefined();

    const metrics = screen.getByTestId('period-metrics');
    const items = Array.from(metrics.querySelectorAll('li'));
    // ①②③ 恒显示 + ④习惯(>0) + ⑤运动(>0) + ⑥wins(>0) = 6 句
    expect(items).toHaveLength(6);
    expect(items[0]?.textContent).toBe(periodLoggedDaysLine(12));
    expect(items[1]?.textContent).toBe(periodDistinctLine(48));
    expect(items[2]?.textContent).toBe(periodMealEntryLine(102));
    expect(items[3]?.textContent).toBe(periodHabitsLine([{ name: '喝水', count: 41 }]));
    expect(items[4]?.textContent).toBe(periodExerciseLine(12, 360));
    expect(screen.getByTestId('period-win-count').textContent).toBe(periodWinCountLine(5));

    // 体重：只有方向 + 差值，句子精确等于 copy 函数产物（后面不接任何判断句，QR-4）
    const weight = screen.getByTestId('period-weight');
    expect(weight.textContent).toBe(periodWeightDownLine(-2.3));

    // 词汇黑名单：页面可见文本一个都不许出现（K26；只看 textContent，
    // 避免把 Tailwind 类名里的 `bg-brand-900/40` 误判成分数式）
    const visibleText = document.body.textContent ?? '';
    for (const word of BANNED_WORDS) {
      expect(visibleText).not.toContain(word);
    }
    // 分数式 / 百分比：有分母就会被读成完成度（AC-11.3.3）
    expect(FRACTION_PATTERN.test(visibleText)).toBe(false);
    expect(visibleText).not.toContain('%');
    // 禁进度原语：阶段回顾视图不得出现 meter / progress
    expect(document.body.querySelector('[role="meter"]')).toBeNull();
    expect(document.body.querySelector('progress')).toBeNull();
  });

  it('零记录 → 整屏空态，不渲染任何指标卡，也不请求 Top5（AC-11.3.5）', async () => {
    const calls = stubFetch([
      { match: '/api/report/weekly', payload: weeklyPayload },
      { match: '/api/report/period', payload: periodPayload({ hasAnyData: false, loggedDays: 0 }) },
      { match: '/api/foods/top', payload: topPayload([]) },
    ]);
    renderReportPage();
    fireEvent.click(screen.getByRole('tab', { name: COPY.reportTabPeriod }));

    // 整屏空态（AC-11.3.5）
    await waitFor(() => {
      expect(screen.getByText(COPY.periodEmpty)).toBeDefined();
    });
    expect(screen.queryByTestId('period-metrics')).toBeNull();
    expect(screen.queryByTestId('period-weight')).toBeNull();
    // 让潜在的请求全部落地后再断言：零记录时 Top5 不该发请求
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.some((call) => call.url.includes('/api/foods/top'))).toBe(false);
  });

  it('体重为 null（含区间内仅一条记录）→ 整块隐藏，不显示 0 也不显示「—」（QR-4）', async () => {
    stubFetch([
      { match: '/api/report/weekly', payload: weeklyPayload },
      {
        match: '/api/report/period',
        payload: periodPayload({ weight: null }),
      },
      { match: '/api/foods/top', payload: topPayload([]) },
    ]);
    renderReportPage();
    await openPeriodTab();

    expect(screen.queryByTestId('period-weight')).toBeNull();
  });

  it('Top5 复用 GET /foods/top（D-4），条目右侧只有「有 N 天」', async () => {
    const calls = stubFetch([
      { match: '/api/report/weekly', payload: weeklyPayload },
      { match: '/api/report/period', payload: periodPayload() },
      { match: '/api/foods/top', payload: topPayload([{ name: '燕麦', dayCount: 12 }]) },
    ]);
    renderReportPage();
    await openPeriodTab();

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/api/foods/top'))).toBe(true);
    });
    expect(screen.getByText(COPY.periodTopTitle)).toBeDefined();
    expect(screen.getByText('燕麦')).toBeDefined();
    expect(screen.getByText(periodTopDaysText(12))).toBeDefined();
  });

  it('档位只有 近 30 天 / 近 365 天 两档，切换 365 后按新档位请求（QR-3）', async () => {
    const calls = stubFetch([
      { match: '/api/report/weekly', payload: weeklyPayload },
      { match: '/api/report/period', payload: periodPayload({ days: 365 }) },
      { match: '/api/foods/top', payload: topPayload([]) },
    ]);
    renderReportPage();
    await openPeriodTab();

    expect(screen.getByRole('tab', { name: periodDayOptionLabel(30) }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: periodDayOptionLabel(365) }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('days=365'))).toBe(true);
    });
    expect(screen.getByRole('tab', { name: periodDayOptionLabel(365) }).getAttribute('aria-selected')).toBe('true');
  });
});
