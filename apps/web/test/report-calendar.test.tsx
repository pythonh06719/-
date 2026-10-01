/**
 * 记录足迹日历测试（C-1，pages/report/FootprintView.tsx + ReportPage tab 外壳）。
 *
 * ## 在这里自动化封口的红线（C-1 最容易踩的线）
 * 1. **月历按当月天数渲染**：格子数 = 当月天数（不多不少）；
 * 2. **有记录点亮、深浅分档**：1 类 / 2 类 / 3 类分别拿 data-level 1/2/3，且只用品牌色；
 * 3. **无记录留白**：无记录的日子是 `data-blank`，**没有**填充类名、**不是**红色、**不出现**「未完成」；
 * 4. **反评判词黑名单**：足迹视图文本**不含**「连续 / 断 / 完成率 / 达成率 / 缺失」与 `%`（无分母）；
 * 5. **点格子能跳转**：点某一天 → 落到 `/diary?date=YYYY-MM-DD`（复用一日档案）。
 *
 * 另覆盖：空月份（一天没记）→ 中性空态 + 仍渲染空网格，而不是报错。
 *
 * ⚠️ 月份不写死：以**运行时的当月**为准（组件默认就是当月），避免测试随日历漂移。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import type { ReactElement } from 'react';
import ReportPage from '@/pages/report/ReportPage';
import { COPY } from '@/lib/copy';

/** 运行时当月与当月天数（独立计算，不复用被测实现）。 */
const now = new Date();
const MONTH = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const DAYS_IN_MONTH = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

const D1 = `${MONTH}-05`;
const D2 = `${MONTH}-12`;
const D3 = `${MONTH}-20`;
/** 一个必定存在的「无记录」日子（与三个点亮日都不同）。 */
const D_BLANK = `${MONTH}-06`;

/** 反评判词黑名单 —— 足迹视图一个都不许出现（C-1 红线）。 */
const BANNED_WORDS = ['连续', '断', '完成率', '完成度', '达成率', '缺失', '未完成'];

/** 足迹响应构造器。 */
function calendarPayload(days: Array<{ date: string; kinds: string[] }>): Record<string, unknown> {
  return {
    month: MONTH,
    from: `${MONTH}-01`,
    to: `${MONTH}-${String(DAYS_IN_MONTH).padStart(2, '0')}`,
    days,
  };
}

/** 默认 payload：1 类 / 2 类 / 3 类各一天，其余留白。 */
const DEFAULT_DAYS = [
  { date: D1, kinds: ['weight'] },
  { date: D2, kinds: ['meal', 'weight'] },
  { date: D3, kinds: ['meal', 'weight', 'water'] },
];

/** `/diary` 探针：把当前 URL 的 `date` 参数渲染出来，用于断言「点格子跳到了哪天」。 */
function DiaryProbe(): ReactElement {
  const [params] = useSearchParams();
  return <div data-testid="diary-probe">{params.get('date') ?? 'none'}</div>;
}

/**
 * 渲染 `ReportPage`（`/report`）并在 `/diary` 挂一个探针，记录所有 fetch 调用。
 */
function renderReport(days: Array<{ date: string; kinds: string[] }> = DEFAULT_DAYS): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/report/calendar')) {
        return { ok: true, status: 200, json: async () => ({ data: calendarPayload(days), error: null }) };
      }
      // 默认 tab（本周）会发 weekly；给一个最小可用响应即可
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            from: `${MONTH}-01`,
            to: `${MONTH}-07`,
            days: [],
            avgIntakeKcal: 0,
            totalExerciseKcal: 0,
            weightChangeKg: null,
            micronutrients: [],
            referenceNote: '',
            distinctFoodCount: 0,
            distinctFoods: [],
            distinctFoodsTruncated: false,
          },
          error: null,
        }),
      };
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/report']}>
        <Routes>
          <Route path="/report" element={<ReportPage />} />
          <Route path="/diary" element={<DiaryProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

/** 切到「足迹」tab 并等待月历渲染完成。 */
async function openFootprintTab(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('tab', { name: COPY.reportTabFootprint }));
  await waitFor(() => {
    expect(screen.getByTestId('footprint-grid')).toBeDefined();
  });
  return screen.getByTestId('report-footprint');
}

describe('记录足迹日历（C-1）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('★ 月历按当月天数渲染；有记录的日期点亮，无记录的日期留白（无填充 / 不是红色 / 无「未完成」）', async () => {
    renderReport();
    const view = await openFootprintTab();

    const grid = screen.getByTestId('footprint-grid');
    // 日期格数量 = 当月天数（补位空格子无 data-date）
    expect(grid.querySelectorAll('[data-date]')).toHaveLength(DAYS_IN_MONTH);

    // 三个点亮日：data-level 分别 1 / 2 / 3（深浅随记录种类数）
    expect(grid.querySelector(`[data-date="${D1}"]`)?.getAttribute('data-level')).toBe('1');
    expect(grid.querySelector(`[data-date="${D2}"]`)?.getAttribute('data-level')).toBe('2');
    expect(grid.querySelector(`[data-date="${D3}"]`)?.getAttribute('data-level')).toBe('3');

    // 无记录的日子：data-blank，且类名里**没有任何填充色**
    const blank = grid.querySelector(`[data-date="${D_BLANK}"]`);
    expect(blank?.getAttribute('data-blank')).toBe('true');
    expect(blank?.className ?? '').not.toMatch(/bg-brand|bg-red|bg-slate-[1-9]/);

    // 全视图不得出现红色 / 警示色
    expect(view.innerHTML).not.toMatch(/bg-red|text-red|border-red|ring-red/);
  });

  it('★ 反评判红线：足迹视图文本不含 连续 / 断 / 完成率 / % 等词（无分母、无 streak、无评分）', async () => {
    renderReport();
    const view = await openFootprintTab();
    const text = view.textContent ?? '';

    for (const word of BANNED_WORDS) {
      expect(text).not.toContain(word);
    }
    expect(text).not.toContain('%');
    // 不得出现「分数式」分母（X/Y）
    expect(/\d+\s*\/\s*\d+/.test(text)).toBe(false);
    // 不得出现进度原语
    expect(view.querySelector('[role="meter"]')).toBeNull();
    expect(view.querySelector('progress')).toBeNull();
  });

  it('★ 点格子 → 跳到那一天的「一日档案」（/diary?date=YYYY-MM-DD）', async () => {
    renderReport();
    await openFootprintTab();

    const cell = screen.getByTestId('footprint-grid').querySelector(`[data-date="${D2}"]`) as HTMLElement;
    expect(cell).not.toBeNull();
    fireEvent.click(cell);

    await waitFor(() => {
      expect(screen.getByTestId('diary-probe').textContent).toBe(D2);
    });
  });

  it('某月一天没记 → 中性空态 + 仍渲染满月网格（留白），不报错', async () => {
    renderReport([]);
    const view = await openFootprintTab();

    expect(screen.getByTestId('footprint-summary').textContent).toBe(COPY.footprintEmptyMonth);
    const grid = screen.getByTestId('footprint-grid');
    expect(grid.querySelectorAll('[data-date]')).toHaveLength(DAYS_IN_MONTH);
    expect(grid.querySelectorAll('[data-level]')).toHaveLength(0);
    expect(view.textContent ?? '').not.toContain('%');
  });

  it('只有「足迹」tab 才请求 /report/calendar（切过去之前不发）', async () => {
    const calls = renderReport();
    // 默认 tab = 本周：此时不应有 calendar 请求
    await waitFor(() => expect(calls.some((url) => url.includes('/api/report/weekly'))).toBe(true));
    expect(calls.some((url) => url.includes('/api/report/calendar'))).toBe(false);

    await openFootprintTab();
    expect(calls.some((url) => url.includes('/api/report/calendar'))).toBe(true);
  });
});
