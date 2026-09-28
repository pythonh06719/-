/**
 * 每餐参考预算的取值来源（B5 · R3.8）测试。
 *
 * 起因：预算原先**只**从本地缓存取 —— 清缓存 / 换设备 / 首次进入时缓存为空 →
 * 分母为 0 → 整段「/ 参考 N kcal」不渲染也不报错，用户以为产品没这个功能。
 *
 * 钉死四件事：
 * ① 本地缓存为空时，预算**从服务端 `/dashboard` 取到**并显示在每餐后面；
 * ② 预算还没回来时**不显示 0**，整段留白（不闪 0 → 真实值）；
 * ③ 服务端取不到时回退缓存（离线兜底仍在），缓存也没有 → 仍然不显示 0；
 * ④ 每餐预算 = 每日预算 × 餐次占比（`MEAL_BUDGET_SHARE`，与 R3.8 同一套占比）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import DiaryPage from '@/pages/diary/DiaryPage';
import { todayKey } from '@/lib/format';
import { CACHE_KEYS, cacheClearAll, cacheGet, cacheSet } from '@/lib/local-cache';
import type { ThemeBudget } from '@/theme/tokens';

const TODAY = todayKey();
const DAILY_BUDGET = 1600;

/** 每餐占比（与 `theme/tokens.ts` 的 `MEAL_BUDGET_SHARE` 一致，避免测试里写第二套数字）。 */
const SHARE = { breakfast: 0.25, lunch: 0.35, dinner: 0.3, snack: 0.1 } as const;

/** 服务端预算摘要（`null` = 服务端没有预算）。 */
type ServerBudget = { intakeRecommended: number; bmr: number; tdee: number } | null;

/** 统一响应包装（与后端全局拦截器一致）。 */
function ok(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) } as Response;
}

/** 饮食接口：今天有一顿早餐 300 kcal。 */
function mealsPayload(): Record<string, unknown> {
  return {
    date: TODAY,
    groups: [
      {
        mealType: 'breakfast',
        logs: [
          {
            id: 1,
            userId: 1,
            loggedDate: TODAY,
            mealType: 'breakfast',
            foodItemId: 1,
            customName: null,
            grams: 100,
            servingUnit: null,
            servingQty: null,
            kcal: 300,
            proteinG: null,
            fatG: null,
            carbG: null,
            fiberG: null,
            sodiumMg: null,
            source: 'search',
            comboId: null,
            note: null,
            sortOrder: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        totalKcal: 300,
      },
    ],
    totalKcal: 300,
  };
}

/** 体重趋势（本用例不关心，给一份合法空趋势即可）。 */
function weightsPayload(): Record<string, unknown> {
  return {
    points: [],
    movingAverage7: [],
    stats: { minKg: null, maxKg: null, latestKg: null, changeKg: null },
    forecast: [],
    goalProgress: null,
  };
}

/** 看板响应。 */
function dashboardPayload(budget: ServerBudget): Record<string, unknown> {
  return {
    date: TODAY,
    goal: null,
    budget,
    intakeKcal: 300,
    burnedKcal: 0,
    remainingKcal: budget === null ? 0 : budget.intakeRecommended - 300,
    progressRatio: budget === null ? 0 : 300 / budget.intakeRecommended,
    waterMl: 0,
    waterGoalMl: 1500,
    miniTrend: [],
    encouragement: '今天也照顾好自己',
    warnings: [],
  };
}

/** 挂起开关：让 `/dashboard` 停住，用于验证「加载中不显示 0」。 */
function createGate(): { hold: () => Promise<void>; release: () => void } {
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

interface StubOptions {
  /** 服务端返回的预算 */
  budget: ServerBudget;
  /** 挂住 `/dashboard` 请求（模拟「还在加载」） */
  holdDashboard?: boolean;
}

/** 安装 fetch 桩，返回请求记录与放闸函数。 */
function stubFetch(options: StubOptions): { calls: string[]; release: () => void } {
  const gate = createGate();
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('/dashboard')) {
        if (options.holdDashboard === true) {
          await gate.hold();
        }
        return ok(dashboardPayload(options.budget));
      }
      if (url.includes('/weights')) {
        return ok(weightsPayload());
      }
      return ok(mealsPayload());
    }),
  );
  return { calls, release: gate.release };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node: ReactElement = (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DiaryPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(node);
}

beforeEach(() => {
  cacheClearAll();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cacheClearAll();
});

describe('每餐参考预算（B5）· 服务端权威', () => {
  it('本地缓存为空 → 预算从 /dashboard 取到，并显示在每餐后面', async () => {
    const { calls } = stubFetch({ budget: { intakeRecommended: DAILY_BUDGET, bmr: 1300, tdee: 2000 } });
    renderPage();

    // 真的去服务端要了预算（而不是只看缓存）
    await waitFor(() => {
      expect(calls.some((url) => url.includes('/api/dashboard'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('daily-budget')).toBeInTheDocument();
    });

    // 每日预算
    expect(screen.getByText(new RegExp(`参考预算 ${DAILY_BUDGET}`))).toBeInTheDocument();

    // 每餐独立预算 = 每日 × 占比（早餐 25% / 午餐 35% / 晚餐 30% / 加餐 10%）
    await waitFor(() => {
      expect(screen.getByText(new RegExp(`/ 参考 ${Math.round(DAILY_BUDGET * SHARE.breakfast)}`))).toBeInTheDocument();
    });
    expect(screen.getByText(new RegExp(`/ 参考 ${Math.round(DAILY_BUDGET * SHARE.lunch)}`))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`/ 参考 ${Math.round(DAILY_BUDGET * SHARE.dinner)}`))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`/ 参考 ${Math.round(DAILY_BUDGET * SHARE.snack)}`))).toBeInTheDocument();
  });

  it('预算还在路上 → 不显示 0，整段留白；回来后直接出现真实值', async () => {
    const { release } = stubFetch({
      budget: { intakeRecommended: DAILY_BUDGET, bmr: 1300, tdee: 2000 },
      holdDashboard: true,
    });
    renderPage();

    // 加载中：这一段**不存在**（不是显示 0）
    await waitFor(() => {
      expect(screen.getByText('今天一共')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('daily-budget')).toBeNull();
    expect(screen.queryByText(/参考预算/)).toBeNull();
    expect(screen.queryByText(/\/ 参考/)).toBeNull();
    // 任何地方都不出现「参考 0 kcal」
    expect(document.body.textContent ?? '').not.toContain('参考 0');

    // 拿到后：一次到位显示真实值（不存在 0 → 1600 的闪烁中间态）
    release();
    await waitFor(() => {
      expect(screen.getByTestId('daily-budget')).toBeInTheDocument();
    });
    expect(screen.getByText(new RegExp(`参考预算 ${DAILY_BUDGET}`))).toBeInTheDocument();
  });

  it('服务端没给预算 → 回退本地缓存（离线兜底仍在）', async () => {
    cacheSet<ThemeBudget>(CACHE_KEYS.localBudget, {
      intakeRecommended: DAILY_BUDGET,
      bmr: 1300,
      tdee: 2000,
    });
    stubFetch({ budget: null });
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('daily-budget')).toBeInTheDocument();
    });
    expect(screen.getByText(new RegExp(`参考预算 ${DAILY_BUDGET}`))).toBeInTheDocument();
  });

  it('服务端与缓存都没有预算 → 不显示这一段，也不显示 0', async () => {
    stubFetch({ budget: null });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('今天一共')).toBeInTheDocument();
    });
    // 缓存没有 + 服务端没有 → 仍然留白，绝不出现 0
    expect(screen.queryByTestId('daily-budget')).toBeNull();
    expect(screen.queryByText(/参考预算/)).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('参考 0');
  });

  it('拿到服务端预算后回写本地缓存（供断网兜底）', async () => {
    stubFetch({ budget: { intakeRecommended: DAILY_BUDGET, bmr: 1300, tdee: 2000 } });
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('daily-budget')).toBeInTheDocument();
    });
    // 缓存被写回 → 下次离线进入仍能看到预算
    expect(cacheGet<ThemeBudget>(CACHE_KEYS.localBudget)).toMatchObject({
      intakeRecommended: DAILY_BUDGET,
    });
  });
});
