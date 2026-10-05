/**
 * NFR-11 guard for the numeric explanations added for fasting, habit streaks,
 * and water progress. Each displayed metric must remain traceable to one
 * dedicated `/why-numbers` entry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import FastingPage from '@/pages/fasting/FastingPage';
import WhyNumbersPage from '@/pages/why-numbers/WhyNumbersPage';

/** Render a routed page with the query provider used by the application. */
function renderWithProviders(element: ReactElement): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

interface ExplanationExpectation {
  readonly id: string;
  readonly heading: string;
  readonly requiredText: readonly string[];
}

const EXPLANATIONS: readonly ExplanationExpectation[] = [
  {
    id: 'why-fasting-title',
    heading: '㉔ 断食计时里的小时数怎么算',
    requiredText: ['targetFastHours', 'elapsedHours', 'targetHours − 同一次计算的未取整已过时长'],
  },
  {
    id: 'why-habit-streak-title',
    heading: '㉕ 习惯的当前连续与历史最佳怎么算',
    requiredText: ['今天已打卡就从今天开始；否则从昨天开始', '全部历史打卡日期里最长的连续段'],
  },
  {
    id: 'why-water-progress-title',
    heading: '㉖ 饮水目标与百分比怎么算',
    requiredText: ['本机有效偏好 > 服务端 goalMl > 默认 2000 ml', 'Math.round 四舍五入到整数，最高显示 100%'],
  },
];

describe('NFR-11：断食、习惯连续与饮水数字均有解释条目', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ data: null, error: null }),
        }) as Response,
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(EXPLANATIONS)('$heading', ({ id, heading, requiredText }) => {
    const { container } = renderWithProviders(<WhyNumbersPage />);
    const title = container.querySelector<HTMLElement>(`#${id}`);

    expect(title).not.toBeNull();
    expect(title).toHaveTextContent(heading);
    const section = title?.closest('section');
    expect(section).not.toBeNull();
    for (const text of requiredText) {
      expect(section).toHaveTextContent(text);
    }
  });

  it('断食页入口直达断食数字说明锚点', () => {
    renderWithProviders(<FastingPage />);

    expect(screen.getByRole('link', { name: '这些数字是怎么来的 →' })).toHaveAttribute(
      'href',
      '/why-numbers#why-fasting-title',
    );
  });
});
