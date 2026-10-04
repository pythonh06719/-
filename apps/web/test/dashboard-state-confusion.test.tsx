import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { DashboardResponse } from '@qsh/shared-types';
import DashboardPage from '@/pages/dashboard/DashboardPage';
import { COPY } from '@/lib/copy';
import { CACHE_KEYS, cacheClearAll, cacheSet } from '@/lib/local-cache';
import { todayKey } from '@/lib/format';

/**
 * 看板「状态混淆」缺陷的回归保护。
 *
 * ## 缺陷本身
 *
 * `DashboardPage` 曾用 `data === null` 判定「未完成引导问卷」。但 `data` 是
 * `dashboardQuery.data ?? buildFallbackDashboard(date)`，即**「本次没取到数据」**：
 * 请求还在路上、请求失败（500 / 断网）都会让它为 `null`。于是**网络一抖，
 * App 就对一个已建档的用户说「去做引导问卷」**。
 *
 * 根因是 `GET /api/dashboard` 的真实契约（已用真实 HTTP 核实，见文件末「真实 HTTP 实证」）：
 * 它**永远返回 200 + 完整对象**，未引导时是 `{ goal: null, budget: null, ... }`，
 * 而不是 `null` 本身。所以「未引导」的判据必须落在**载荷内部**，不能落在外层。
 *
 * ## 本文件覆盖
 *
 * 1. 500 → 错误态，且**不得**出现引导问卷 CTA（缺陷正身）
 * 2. 断网 + 无缓存 → 同样错误态
 * 3. 200 + `{ goal: null, budget: null }` → 仍显示「去做引导问卷」（别把功能改坏）
 * 4. 200 + 有预算但 `goal` 为 null → **照常渲染看板**（残缺载荷不该把用户赶去引导）
 * 5. 加载中 → 骨架（`aria-busy`），不闪空态
 * 6. 500 + 有本地缓存 → 渲染缓存内容**并**给出离线说明，不谎称未引导
 * 7. 「重试」按钮真的会重新发一次请求
 *
 * ## wait 锚点独立于被测行为
 *
 * 所有等待都锚在**与被测行为无关**的锚点上（`aria-busy` 骨架消失 / 某个稳定文案出现），
 * 绝不锚在「引导问卷 CTA 出现」或「错误文案出现」这类正是被断言对象上。
 */

function ok(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data, error: null }),
  } as unknown as Response;
}

/** 未引导：服务端明确说「既无目标也无预算」。 */
const FRESH_PAYLOAD: DashboardResponse = {
  date: '2026-09-12',
  goal: null,
  budget: null,
  intakeKcal: 0,
  burnedKcal: 0,
  remainingKcal: 0,
  progressRatio: 0,
  waterMl: 0,
  waterGoalMl: 2000,
  miniTrend: [],
  encouragement: '今天也照顾好自己',
  warnings: [],
};

/** 已引导：有目标、有预算。 */
const ONBOARDED_PAYLOAD: DashboardResponse = {
  ...FRESH_PAYLOAD,
  goal: {
    id: 1,
    userId: 1,
    startWeightKg: 60,
    targetWeightKg: 55,
    targetWeeks: 12,
    weeklyLossKg: 0.42,
    macroRatio: { protein: 25, fat: 25, carb: 50 },
    isActive: true,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  } as DashboardResponse['goal'],
  budget: { intakeRecommended: 1500, bmr: 1320, tdee: 1584 },
  remainingKcal: 1500,
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

/** 等骨架消失（锚点独立于被测行为）。 */
async function waitSettled(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByText('正在读取今天的数据')).toBeNull();
  });
}

beforeEach(() => {
  cacheClearAll();
  vi.restoreAllMocks();
});

describe('看板状态判别 · 请求失败 ≠ 未引导', () => {
  it('★ 500 → 错误态，且不出现「去做引导问卷」', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          data: null,
          error: { code: 'E_INTERNAL', message: '服务端在开小差，稍后我们再来一次' },
        }),
      })),
    );
    renderDashboard();

    expect(await screen.findByText(COPY.pageFallbackTitle)).toBeInTheDocument();
    // 反向断言 —— 这条正是缺陷的正身
    expect(screen.queryByText('去做引导问卷')).toBeNull();
    expect(screen.queryByText(COPY.emptyToday)).toBeNull();
  });

  it('断网 + 无缓存 → 同样是错误态，不是引导问卷', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    renderDashboard();

    expect(await screen.findByText(COPY.pageFallbackTitle)).toBeInTheDocument();
    expect(screen.queryByText('去做引导问卷')).toBeNull();
  });

  it('加载中显示骨架（aria-busy），不闪空态', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return ok(ONBOARDED_PAYLOAD);
      }),
    );
    renderDashboard();

    // 骨架是「正在取」的唯一表达
    expect(await screen.findByText('正在读取今天的数据')).toBeInTheDocument();
    expect(document.querySelector('section[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText('去做引导问卷')).toBeNull();

    release();
    await waitSettled();
    expect(await screen.findByText('今天的记录')).toBeInTheDocument();
  });
});

describe('看板状态判别 · 真·未引导仍显示引导问卷（别改坏）', () => {
  it('200 + goal:null + budget:null → 显示「去做引导问卷」', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(FRESH_PAYLOAD)),
    );
    renderDashboard();

    expect(await screen.findByText('去做引导问卷')).toBeInTheDocument();
    expect(screen.queryByText(COPY.pageFallbackTitle)).toBeNull();
  });

  it('★ 有预算但 goal 为 null（残缺载荷）→ 照常渲染看板，不赶去引导', async () => {
    // 判据是「goal 与 budget 同时为空」，不是单看 goal：
    // 只有服务端认定「既无档案也无目标」时，引导问卷才是唯一出路。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ ...ONBOARDED_PAYLOAD, goal: null })),
    );
    renderDashboard();

    expect(await screen.findByText('今天的记录')).toBeInTheDocument();
    expect(screen.queryByText('去做引导问卷')).toBeNull();
  });
});

describe('看板状态判别 · 有缓存时的降级表达', () => {
  it('500 + 本地有缓存 → 渲染缓存并给离线说明，不谎称未引导', async () => {
    // 先写一份「今天」的缓存副本（模拟此前成功取过）
    cacheSet(CACHE_KEYS.dashboard(todayKey()), ONBOARDED_PAYLOAD);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          data: null,
          error: { code: 'E_INTERNAL', message: '服务端在开小差' },
        }),
      })),
    );
    renderDashboard();

    // 缓存救场：看板内容在
    expect(await screen.findByText('今天的记录')).toBeInTheDocument();
    expect(screen.queryByText('去做引导问卷')).toBeNull();
  });

  it('★ 断网 + 仅本地预算缓存 → 用缓存兜底渲染，且不谎称未引导', async () => {
    // 这一条守住 `notOnboarded` 里 `isSuccess` 那个条件的必要性。
    //
    // `buildFallbackDashboard` 会用 `CACHE_KEYS.localBudget` 伪造一个 dashboard 对象，
    // 它的 `goal` 字段**恒为 `null`**（见 DashboardPage 的 fallback 构造）。
    // 若 `notOnboarded` 不要求 `isSuccess`，这个 `null` 就会被当成「未引导」——
    // 于是一个已建档的用户离线时，又被要求去做引导问卷（同一个缺陷换个入口）。
    //
    // 期望行为（TC-47 离线可看）：用本地预算兜底把看板画出来，不弹错误、不谎称未引导。
    cacheSet(CACHE_KEYS.localBudget, { intakeRecommended: 1500, bmr: 1320, tdee: 1584 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    renderDashboard();

    expect(await screen.findByText('今天的记录')).toBeInTheDocument();
    expect(screen.queryByText('去做引导问卷')).toBeNull();
    expect(screen.queryByText(COPY.pageFallbackTitle)).toBeNull();
  });
});

describe('看板错误态 · 重试真的重新发请求', () => {
  it('点「重试」会再打一次 /dashboard', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ data: null, error: { code: 'E_INTERNAL', message: 'boom' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderDashboard();

    const retry = await screen.findByText(COPY.pageFallbackRetry);
    const before = fetchMock.mock.calls.length;
    retry.click();
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    });
  });
});
