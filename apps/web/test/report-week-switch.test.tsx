/**
 * 周报可回看历史周（B2）测试。
 *
 * 钉死六件事：
 * ① 「上一周 / 下一周」真的把 `endDate` 传给了后端（不是只换个标签）；
 * ② **未来禁用**：本周时「下一周」是 `disabled`（按钮仍在，不是隐藏后突然失效）；
 * ③ **往前翻不设硬上限**：连翻多周照常请求；
 * ④ `<input type="date">` 跳到某一天 → 落在「以这天为最后一天」的那一周；未来日期被裁到今天；
 * ⑤ **历史周空态**：一条记录都没有时只给中性文案，**不渲染** 0 千卡 / 0 次打卡那面墙；
 * ⑥ 切周期间**不显示上一周的数据**（不留旧数字，也不闪 0）。
 *
 * 语气硬约束（PRD §7）：空态措辞中性，不出现指责 / 催促 / 评分。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WeeklyReportView from '@/pages/report/WeeklyReportView';
import { addDays, formatMonthDay, todayKey } from '@/lib/format';
import { COPY, weekRelativeLabel, weeklyLoadingLine } from '@/lib/copy';
import { hasAnyWeeklyRecord } from '@qsh/core';

const TODAY = todayKey();
const PREV = addDays(TODAY, -7);
const PREV2 = addDays(TODAY, -14);

interface DayPayload {
  date: string;
  intakeKcal: number;
  exerciseKcal: number;
  waterMl: number;
  habitsDone: number;
  habitsTotal: number;
}

/** 造一周数据（末日 = endDate，与后端 `from = to − 6` 同口径）。 */
function weekDays(endDate: string, withRecords = true): DayPayload[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(endDate, index - 6);
    return {
      date,
      intakeKcal: withRecords ? 1000 + index * 100 : 0,
      exerciseKcal: withRecords ? 100 : 0,
      waterMl: withRecords ? 1500 : 0,
      habitsDone: withRecords ? 1 : 0,
      habitsTotal: 3,
    };
  });
}

/** 按请求的 `endDate` 构造周报响应（`withRecords=false` → 整周零记录）。 */
function weeklyPayload(endDate: string, withRecords = true): Record<string, unknown> {
  return {
    from: addDays(endDate, -6),
    to: endDate,
    days: weekDays(endDate, withRecords),
    avgIntakeKcal: withRecords ? 1300 : 0,
    totalExerciseKcal: withRecords ? 700 : 0,
    weightChangeKg: withRecords ? -0.4 : null,
    micronutrients: [],
    referenceNote: '参考《中国居民膳食营养素参考摄入量》。',
    distinctFoodCount: withRecords ? 12 : 0,
    distinctFoods: [],
    distinctFoodsTruncated: false,
  };
}

/** 统一响应包装（与后端全局拦截器一致）。 */
function ok(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data, error: null }),
  } as Response;
}

/** 从请求 URL 里取出 `endDate`。 */
function endDateOf(url: string): string {
  return new URL(url, 'http://localhost').searchParams.get('endDate') ?? '';
}

/** 最近一次请求到的周报 `endDate`。 */
function latestEndDate(calls: string[]): string {
  const weekly = calls.filter((url) => url.includes('/api/report/weekly'));
  return weekly.length === 0 ? '' : endDateOf(weekly[weekly.length - 1]!);
}

/** 挂起开关：让「非首屏」的请求停在这里，用于验证切周期间不显示旧数据。 */
function createGate(): { hold: (endDate: string) => Promise<void>; release: () => void } {
  let resolve: (() => void) | null = null;
  return {
    hold: async () => {
      await new Promise<void>((next) => {
        resolve = next;
      });
    },
    release: () => {
      resolve?.();
      resolve = null;
    },
  };
}

function renderView(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node: ReactElement = (
    <QueryClientProvider client={client}>
      <WeeklyReportView />
    </QueryClientProvider>
  );
  render(node);
}

/** 等到目标周的数据渲染出来（标题里带着该周的区间）。 */
async function waitForWeek(endDate: string): Promise<void> {
  const title = `近 7 天（${addDays(endDate, -6)} ~ ${endDate}）`;
  await waitFor(() => {
    expect(screen.getByText(title)).toBeInTheDocument();
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('周报可回看历史周（B2）· 翻周', () => {
  it('默认看本周；点「上一周」把 endDate 传给后端，窗口标签跟着变', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return ok(weeklyPayload(endDateOf(url)));
      }),
    );
    renderView();
    await waitForWeek(TODAY);

    // ① 默认本周，请求带的是今天
    expect(latestEndDate(calls)).toBe(TODAY);
    expect(screen.getByTestId('week-window-label').textContent).toContain(weekRelativeLabel(0));

    // ② 上一周：真的换了查询参数（不是只换标签）
    fireEvent.click(screen.getByRole('button', { name: COPY.weekPrevAria }));
    await waitFor(() => {
      expect(latestEndDate(calls)).toBe(PREV);
    });
    await waitForWeek(PREV);

    const label = screen.getByTestId('week-window-label').textContent ?? '';
    expect(label).toContain(formatMonthDay(addDays(PREV, -6)));
    expect(label).toContain(formatMonthDay(PREV));
    expect(label).toContain(weekRelativeLabel(1));
  });

  it('未来禁用：本周时「下一周」disabled；翻到上一周后可点，点回本周又 disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ok(weeklyPayload(endDateOf(url)))),
    );
    renderView();
    await waitForWeek(TODAY);

    const next = () => screen.getByRole('button', { name: COPY.weekNextAria });
    const prev = () => screen.getByRole('button', { name: COPY.weekPrevAria });

    // 未来周按钮**渲染但禁用**（不是隐藏后突然失效）
    expect(next()).toBeInTheDocument();
    expect(next()).toBeDisabled();

    fireEvent.click(prev());
    await waitForWeek(PREV);
    expect(next()).not.toBeDisabled();

    fireEvent.click(next());
    await waitForWeek(TODAY);
    expect(next()).toBeDisabled();
  });

  it('往前翻不设硬上限：连点 3 次「上一周」一路请求更早的周', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return ok(weeklyPayload(endDateOf(url)));
      }),
    );
    renderView();
    await waitForWeek(TODAY);

    const prev = () => screen.getByRole('button', { name: COPY.weekPrevAria });
    fireEvent.click(prev());
    await waitFor(() => expect(latestEndDate(calls)).toBe(PREV));
    fireEvent.click(prev());
    await waitFor(() => expect(latestEndDate(calls)).toBe(PREV2));
    fireEvent.click(prev());
    await waitFor(() => expect(latestEndDate(calls)).toBe(addDays(TODAY, -21)));
    await waitForWeek(addDays(TODAY, -21));
  });

  it('日期控件跳到某一天 → 落在以这天为最后一天的那一周；未来日期裁到今天', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return ok(weeklyPayload(endDateOf(url)));
      }),
    );
    renderView();
    await waitForWeek(TODAY);

    const picker = screen.getByLabelText(COPY.weekJumpLabel) as HTMLInputElement;
    expect(picker.getAttribute('type')).toBe('date');
    expect(picker.getAttribute('max')).toBe(TODAY);

    // 跳到 30 天前：那一周 = [−36, −30]
    const jump = addDays(TODAY, -30);
    fireEvent.change(picker, { target: { value: jump } });
    await waitFor(() => expect(latestEndDate(calls)).toBe(jump));
    await waitForWeek(jump);
    const label = screen.getByTestId('week-window-label').textContent ?? '';
    expect(label).toContain(formatMonthDay(addDays(jump, -6)));

    // 未来日期（虽然 max 已限制，手打也要被裁到今天）
    fireEvent.change(picker, { target: { value: addDays(TODAY, 3) } });
    await waitFor(() => expect(latestEndDate(calls)).toBe(TODAY));
    await waitForWeek(TODAY);
  });

  it('「回到本周」只在非本周时出现，点了就回今天', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return ok(weeklyPayload(endDateOf(url)));
      }),
    );
    renderView();
    await waitForWeek(TODAY);
    expect(screen.queryByRole('button', { name: COPY.weekBackToCurrent })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: COPY.weekPrevAria }));
    await waitForWeek(PREV);
    fireEvent.click(screen.getByRole('button', { name: COPY.weekBackToCurrent }));
    await waitFor(() => expect(latestEndDate(calls)).toBe(TODAY));
    expect(screen.queryByRole('button', { name: COPY.weekBackToCurrent })).toBeNull();
  });
});

describe('周报历史周空态（B2）· 无负罪感', () => {
  it('历史周一条记录都没有 → 中性空态，不渲染 0 值墙', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ok(weeklyPayload(endDateOf(url), false))),
    );
    renderView();

    // 翻到上一周（那一周没有记录）
    fireEvent.click(screen.getByRole('button', { name: COPY.weekPrevAria }));
    await waitFor(() => {
      expect(screen.getByTestId('weekly-empty')).toBeInTheDocument();
    });

    expect(screen.getByText(COPY.weeklyEmptyTitle)).toBeInTheDocument();
    expect(screen.getByText(COPY.weeklyEmptyNote)).toBeInTheDocument();

    // 空态也要说清「哪一周没有记录」（NFR-11），但**不得**出现 0 值指标墙 / 进度条 / 分数式
    const emptyText = screen.getByTestId('weekly-empty').textContent ?? '';
    expect(emptyText).toContain(`近 7 天（${addDays(PREV, -6)} ~ ${PREV}）`);
    expect(screen.queryByText('日均摄入')).toBeNull();
    expect(screen.queryByText('运动消耗')).toBeNull();
    expect(screen.queryByText('习惯达成率')).toBeNull();
    expect(document.body.querySelector('[role="meter"]')).toBeNull();
    expect(document.querySelector('svg[role="img"]')).toBeNull();

    // 语气硬约束：不指责、不焦虑、不统计缺失
    const text = document.body.textContent ?? '';
    for (const banned of ['失败', '缺失', '缺席', '未记录', '断签', '完成率', '达成率', '0 kcal', '0 次']) {
      expect(text).not.toContain(banned);
    }
  });

  it('有记录的周照常渲染数字（空态不能误伤）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ok(weeklyPayload(endDateOf(url), true))),
    );
    renderView();
    await waitForWeek(TODAY);
    expect(screen.queryByTestId('weekly-empty')).toBeNull();
    expect(screen.getByText('日均摄入')).toBeInTheDocument();
    expect(hasAnyWeeklyRecord(weeklyPayload(TODAY, true))).toBe(true);
    expect(hasAnyWeeklyRecord(weeklyPayload(TODAY, false))).toBe(false);
  });
});

describe('周报切周不闪旧数据（B2）', () => {
  it('切到上一周后、新数据到达前：只显示「正在整理 <目标周>」，不留上一周的数字', async () => {
    const gate = createGate();
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (first) {
          first = false;
          return ok(weeklyPayload(TODAY));
        }
        await gate.hold(endDateOf(url));
        return ok(weeklyPayload(endDateOf(url)));
      }),
    );
    renderView();
    await waitForWeek(TODAY);

    fireEvent.click(screen.getByRole('button', { name: COPY.weekPrevAria }));

    // 切周瞬间：本周的数字必须已经消失，只剩目标周的占位文案
    await waitFor(() => {
      expect(screen.queryByText(`近 7 天（${addDays(TODAY, -6)} ~ ${TODAY}）`)).toBeNull();
    });
    const loading = screen.getByText(/正在整理/);
    expect(loading.textContent).toBe(
      weeklyLoadingLine(
        `${formatMonthDay(addDays(PREV, -6))} ~ ${formatMonthDay(PREV)} · ${weekRelativeLabel(1)}`,
      ),
    );
    // 窗口标签立刻跟着切（用户看得出自己在看哪一周）
    expect(screen.getByTestId('week-window-label').textContent).toContain(formatMonthDay(PREV));

    // 放闸 → 新一周数据出现，且是**上一周**的区间
    gate.release();
    await waitForWeek(PREV);
  });
});
