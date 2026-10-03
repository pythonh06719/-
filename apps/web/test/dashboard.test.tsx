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

    // 剩余热量（已降级为次要信息，但数值仍在）
    expect(await screen.findByText('1200')).toBeInTheDocument();
    // 鼓励语
    expect(screen.getByText('今天也照顾好自己')).toBeInTheDocument();
    // 生活化行动卡：主 CTA「喝一杯水」（250ml = 一杯）
    expect(screen.getByRole('button', { name: /喝一杯水/ })).toBeInTheDocument();
    // 行动优先：记一餐 / 动一动 两个入口
    expect(screen.getByRole('link', { name: /记一餐/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /动一动/ })).toBeInTheDocument();
  });

  /**
   * 回归保护：热量进度**不再**以「进度环 / 百分比」呈现。
   *
   * 背景：首屏曾有一个 96px 珊瑚色圆环，环内写「117% / 今日进度」。它是全屏最大、最饱和的
   * 元素 —— 形态本身就把「超标 17%」变成了一个**评分**，与同屏喝水的轻描淡写自相矛盾。
   * 降级后改为纯文字：定性胶囊 + 生活口吻主行 + 绝对值数字行。
   *
   * 这里断言的是**形状不存在**（无 `role="img"` 的热量进度、无百分号数字），
   * 而非断言某段文案 —— 防止有人日后把评分环加回来。
   */
  it('热量进度不以进度环/百分比呈现（红线：无评分暗示）', async () => {
    const { container } = renderDashboard();
    await screen.findByText('1200');

    // 1) 旧环的可访问名（`role="img"` + `aria-label="今日热量进度 N%"`）已消失
    expect(screen.queryByLabelText(/今日热量进度/)).toBeNull();
    expect(screen.queryByLabelText(/今日进度/)).toBeNull();
    // 2) 摘要卡内不再有任何进度环 / 大号百分比数字。
    //    （用标题定位这张卡，避开同页 `Sparkline` 也用 `role="img"` 的情况）
    const card = screen.getByText('今天的记录').closest('div')!;
    expect(card.querySelector('[role="img"]')).toBeNull();
    expect(card.querySelector('svg')).toBeNull();
    expect(card.textContent).not.toMatch(/%/);
    // 3) 定量信息仍在（绝对值 + 定性措辞），信息量没有随环一起丢掉
    expect(screen.getByText('今天还很宽裕')).toBeInTheDocument();
    expect(screen.getByText('舒服')).toBeInTheDocument();
    expect(screen.getByText('1200')).toBeInTheDocument();
  });

  it('后端不可用（网络错误）时回退缓存且不白屏', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    renderDashboard();

    // 无缓存时显示生活化的引导入口（不抛错、不白屏）
    await waitFor(() => {
      expect(screen.getByText('今天还没记，从一杯水开始也行')).toBeInTheDocument();
    });
  });
});
