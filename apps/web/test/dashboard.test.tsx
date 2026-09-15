import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { DashboardResponse } from '@qsh/shared-types';
import DashboardPage from '@/pages/dashboard/DashboardPage';
import { cacheClearAll } from '@/lib/local-cache';

/**
 * 看板页面渲染测试（T04 DoD 第 5 项）—— 在后端不可用的前提下用 mock 数据验证不崩。
 *
 * - 通过 stub `fetch` 返回统一 `{ data, error: null }` 包装（K2）
 * - 断言：剩余热量大数字、进度环、鼓励语均正确渲染
 */

const PAYLOAD: DashboardResponse = {
  date: '2026-09-12',
  goal: null,
  budget: { intakeRecommended: 1500, bmr: 1320, tdee: 1584 },
  intakeKcal: 300,
  burnedKcal: 0,
  remainingKcal: 1200,
  progressRatio: 0.2,
  waterMl: 500,
  waterGoalMl: 1500,
  miniTrend: [
    { date: '2026-09-10', weightKg: 60.2 },
    { date: '2026-09-11', weightKg: 60 },
    { date: '2026-09-12', weightKg: 59.8 },
  ],
  encouragement: '今天也照顾好自己',
  warnings: [],
};

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    cacheClearAll();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: PAYLOAD, error: null }),
      })),
    );
  });

  it('mock 数据下渲染剩余热量、进度与鼓励语', async () => {
    renderDashboard();

    // 剩余热量大数字
    expect(await screen.findByText('1200')).toBeInTheDocument();
    // 进度环
    expect(screen.getByLabelText(/今日热量进度/)).toBeInTheDocument();
    // 鼓励语
    expect(screen.getByText('今天也照顾好自己')).toBeInTheDocument();
    // 饮水组件
    expect(screen.getByText('+ 250 ml')).toBeInTheDocument();
  });

  it('后端不可用（网络错误）时回退缓存且不白屏', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    renderDashboard();

    // 无缓存时显示引导入口（不抛错、不白屏）
    await waitFor(() => {
      expect(screen.getByText('今天开始记录吧')).toBeInTheDocument();
    });
  });
});
