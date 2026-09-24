/**
 * 体重波动的日常原因（N3）测试。
 *
 * 钉死两件事：
 * ① 体重上涨时，把日常里本来就会让数字上浮的原因**摊开讲**（而不是只留一句「波动很正常」）——
 *    这里的 `isWeightRising` 判定是「最后一条 > 上一条」，所以递增序列 = 上涨。
 * ② **语气红线**：不得出现因果归因或指责（「因为你…」「吃多了」）。
 *    这是本实现与「数据归因」方案的关键区别 —— 用数据去推断「因为你昨天吃多了」会把身体正常的
 *    起伏变成指责，直接违背「无负罪感」这条硬约束，所以这里刻意只陈述日常事实、不做因果推断。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { WeightTrendResponse } from '@qsh/shared-types';
import WeightPage from '@/pages/weight/WeightPage';
import { COPY } from '@/lib/copy';
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
    stats: { minKg: 58, maxKg: 70, latestKg: points[29]!.weightKg, changeKg: 0 },
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

describe('体重波动的日常原因（N3）', () => {
  beforeEach(() => {
    cacheClearAll();
    // 平台期卡的展示频控状态会跨用例残留 → 每个用例都从「从未展示 / 从未关闭」开始
    clearPlateauVisibility();
  });

  it('体重上涨 → 摊开讲日常原因（水分 / 食物重量 / 盐分 / 作息）', async () => {
    renderWeightPage(payload((index) => 60 + index * 0.1));

    await waitFor(() => {
      expect(screen.getByText(COPY.weightRiseTitle)).toBeInTheDocument();
    });
    expect(screen.getByText(COPY.weightRiseReasonWater)).toBeInTheDocument();
    expect(screen.getByText(COPY.weightRiseReasonFood)).toBeInTheDocument();
    expect(screen.getByText(COPY.weightRiseReasonSalt)).toBeInTheDocument();
    expect(screen.getByText(COPY.weightRiseReasonSleep)).toBeInTheDocument();
    expect(screen.getByText(COPY.weightRiseClosing)).toBeInTheDocument();
  });

  it('体重没上涨 → 不显示这张卡', async () => {
    renderWeightPage(payload((index) => 70 - index * 0.1));

    await waitFor(() => {
      expect(screen.queryByText(COPY.weightRiseTitle)).not.toBeInTheDocument();
    });
  });

  it('语气红线：不做因果归因，也不指责', async () => {
    renderWeightPage(payload((index) => 60 + index * 0.1));

    await waitFor(() => {
      expect(screen.getByText(COPY.weightRiseTitle)).toBeInTheDocument();
    });

    const text = screen.getByText(COPY.weightRiseTitle).closest('section')?.textContent ?? '';
    // 不得出现把原因归到用户行为上的措辞
    for (const forbidden of ['因为你', '吃多了', '都是你', '应该少吃', '记得控制', '超标', '失败']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
