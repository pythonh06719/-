/**
 * 饮水默认目标统一为 2000（缺陷收尾 · 项 7）。
 *
 * 背景：前端 `DEFAULT_WATER_GOAL_ML`（`theme/tokens.ts`）曾是 **1500**，而服务端真源是 **2000**
 * （`water.service.ts` 的 `?? 2000` + `schema.prisma` `UserSettings.waterGoalMl @default(2000)`）。
 * 断网 / 接口失败时，看板显示「目标 6 杯」（1500/250）、运动页显示「0 / 2000 ml」——
 * 同一天、同一用户、两个目标。而且 1500 不是任何一端的选择，只在用户最需要确定性的离线时刻生效。
 *
 * 本用例钉死两条离线 / 失败路线都落 **2000**：
 * - 看板离线兜底（`buildFallbackDashboard`）；
 * - 运动页 `GET /water` 失败（`?? 2000`）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import DashboardPage from '@/pages/dashboard/DashboardPage';
import ExercisePage from '@/pages/exercise/ExercisePage';
import { CACHE_KEYS, cacheClearAll, cacheSet } from '@/lib/local-cache';

function renderWithProviders(node: ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/dashboard']}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('饮水默认目标统一为 2000（项 7）', () => {
  beforeEach(() => {
    cacheClearAll();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('看板离线兜底：饮水目标是 2000（「目标 8 杯」而非 1500 的「6 杯」）', async () => {
    // 离线兜底需要有本地预算缓存（否则整页走引导空态，看不到饮水卡）
    cacheSet(CACHE_KEYS.localBudget, { intakeRecommended: 1800 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    renderWithProviders(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('还没喝 / 目标 8 杯')).toBeInTheDocument();
    });
    // 2000 / 250 = 8 杯；若是旧的 1500 会显示「目标 6 杯」
    expect(screen.queryByText('还没喝 / 目标 6 杯')).toBeNull();
  });

  it('运动页接口失败：饮水目标是 2000（不落回 1500）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    renderWithProviders(<ExercisePage />);

    await waitFor(() => {
      expect(screen.getByText(/0 \/ 2000 ml/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/0 \/ 1500 ml/)).toBeNull();
  });
});
