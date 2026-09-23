/**
 * 习惯「连续日历」测试（pages/habits/HabitCalendar.tsx + HabitsPage 接线，C3）。
 *
 * 钉死两条最容易回归的语义：
 * - **渲染**：7×5 = 35 格，打过卡 = 实心（`data-checked="true"`），没打卡 = 空心（`"false"`）；
 * - **语气（产品红线）**：断签不得是红叉 / 不得出现「已断 N 天」/ 全局不得出现 coral / red 语义色；
 *   aria 只播报「有几天打了卡」。
 *
 * 边界：无记录、记录落在窗口外（今天−35 及更早、未来）、恰好窗口左端点（今天−34）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import HabitCalendar, { HABIT_CALENDAR_DAYS } from '@/pages/habits/HabitCalendar';
import HabitsPage from '@/pages/habits/HabitsPage';
import { COPY } from '@/lib/copy';
import { addDays, todayKey } from '@/lib/format';

/** 取网格里所有「日期格」（排除星期表头）。 */
function cells(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-date]'));
}

/** 取实心（已打卡）的日期格。 */
function checkedCells(container: HTMLElement): HTMLElement[] {
  return cells(container).filter((node) => node.getAttribute('data-checked') === 'true');
}

describe('HabitCalendar（C3 连续日历）', () => {
  it('渲染 35 个日期格；打过卡的实心、没打卡的空心', () => {
    const today = '2026-09-30';
    const { container } = render(
      <HabitCalendar checkedDates={[addDays(today, -1), today]} today={today} />,
    );

    const all = cells(container);
    expect(all).toHaveLength(HABIT_CALENDAR_DAYS);
    expect(checkedCells(container)).toHaveLength(2);
    // 今天与昨天实心，前天空心
    expect(container.querySelector(`[data-date="${today}"]`)?.getAttribute('data-checked')).toBe('true');
    expect(container.querySelector(`[data-date="${addDays(today, -1)}"]`)?.getAttribute('data-checked')).toBe('true');
    expect(container.querySelector(`[data-date="${addDays(today, -2)}"]`)?.getAttribute('data-checked')).toBe('false');

    // 无障碍只播报「有几天打了卡」
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '最近 35 天里，有 2 天打过卡');
    expect(screen.getByText(COPY.habitCalendarTitle)).toBeDefined();
  });

  it('窗口边界：左端点（今天−34）计入，今天−35 及未来不计入', () => {
    const today = '2026-09-30';
    const leftEdge = addDays(today, -(HABIT_CALENDAR_DAYS - 1)); // 今天-34
    const { container } = render(
      <HabitCalendar
        checkedDates={[addDays(today, -35), addDays(today, -34), addDays(today, 1), leftEdge]}
        today={today}
      />,
    );

    // 仅 leftEdge（== 今天-34）落在窗口内
    expect(checkedCells(container).map((node) => node.getAttribute('data-date'))).toEqual([leftEdge]);
    expect(container.querySelector(`[data-date="${addDays(today, -35)}"]`)).toBeNull();
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '最近 35 天里，有 1 天打过卡');
  });

  it('无任何记录 → 0 实心 + 中性引导语文案，且不含惩罚性表述', () => {
    const { container } = render(<HabitCalendar checkedDates={[]} today="2026-09-30" />);

    expect(checkedCells(container)).toHaveLength(0);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '最近 35 天里，有 0 天打过卡');
    expect(screen.getByText(COPY.habitCalendarEmpty)).toBeDefined();

    const html = container.innerHTML;
    for (const banned of ['coral', 'red', '已断', '断签', '×', '✗']) {
      expect(html).not.toContain(banned);
    }
  });
});

describe('HabitsPage 连续日历接线（C3）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  function renderPage(habits: unknown[]): void {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { today: todayKey(), habits }, error: null }),
      })),
    );
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <HabitsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('每个习惯渲染一张日历，实心数 == 该习惯 recentDates 命中窗口的天数', async () => {
    const today = todayKey();
    renderPage([
      {
        id: 1,
        code: 'water',
        name: '喝水',
        icon: '💧',
        targetPerDay: 1,
        isActive: true,
        doneToday: true,
        currentStreak: 3,
        bestStreak: 5,
        // 3 天在窗口内 + 1 天在窗口外（不计）
        recentDates: [addDays(today, -2), addDays(today, -1), today, addDays(today, -40)],
      },
      {
        id: 2,
        code: 'steps',
        name: '散步',
        icon: '🚶',
        targetPerDay: 1,
        isActive: true,
        doneToday: false,
        currentStreak: 0,
        bestStreak: 2,
        recentDates: [],
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText('喝水')).toBeDefined();
    });

    const images = screen.getAllByRole('img');
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('aria-label', '最近 35 天里，有 3 天打过卡');
    expect(images[1]).toHaveAttribute('aria-label', '最近 35 天里，有 0 天打过卡');
  });
});
