/**
 * D-3 体重单位「斤」切换 —— 前端接线测试。
 *
 * ## 口径
 * 体重**存储与 API 传参恒为 kg**；`weightUnit` 只是一个展示偏好，
 * 决定把 kg 换算成「斤」（1 kg = 2 市斤）来显示与输入。换算属**等价换算**，
 * 不改变任何数据、不产生任何新口径（NFR-11）。
 *
 * ## 本文件钉死的行为
 * ① **纯函数双向 + 精确往返**：`×2 / ÷2` 在浮点下精确，往返不丢精度（65.5 → 131 → 65.5）；
 * ② **显示双向**：同一份数据在 kg 与 斤 两种模式下都正确（60 kg ↔ 120 斤），且不串单位；
 * ③ **★ 输入回写**：斤模式下输入 131 → 提交的 API body 是 **65.5 kg**；
 * ④ **★ 登出清理**：登出后体重单位偏好被清（GAP-4 P0-1 式断言：localStorage 清空 + 内存态复位）；
 * ⑤ **★ 离线重推**：离线改体重单位 → 联网后补推最新值（P0-2 dirty 机制）；
 * ⑥ 顶栏体重单位按钮可用（kg ↔ 斤，写入本地偏好）；
 * ⑦ 文案红线：不出现「失败 / 错误 / 崩溃」等词，不出现红色类名。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { WeightTrendResponse, WeightUnit } from '@qsh/shared-types';

import {
  JIN_PER_KG,
  WEIGHT_UNIT_STORAGE_KEY,
  fromDisplayWeight,
  jinToKg,
  kgToJin,
  toDisplayWeight,
  useUnitStore,
} from '@/lib/units';
import {
  goalBaselineLine,
  goalCurrentWeightLabel,
  goalRemainingLine,
  goalTargetLine,
  goalTargetWeightLabel,
  periodWeightDownLine,
  periodWeightUpLine,
  plateauSlopeLine,
  plateauStalledLine,
  weightInputLabel,
} from '@/lib/copy';
import { COPY } from '@/lib/copy';
import { useAuthStore } from '@/lib/auth.store';
import { cacheClearAll } from '@/lib/local-cache';
import { __resetDirtyForTest, flushPendingSettings, hasPendingSettings } from '@/lib/settings-sync';
import { __resetMemoryQueueForTest, clearQueuedRequests } from '@/pwa/offline-queue';
import { todayKey } from '@/lib/format';
import AppShell from '@/components/layout/AppShell';
import WeightPage from '@/pages/weight/WeightPage';
import GoalSettingsCard from '@/pages/profile/GoalSettingsCard';

/** 统一的 `{ data, error: null }` 成功响应。 */
function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** 造一份单点趋势响应（`GET /weights`）。 */
function trend(weightKg: number): WeightTrendResponse {
  const today = todayKey();
  return {
    points: [{ date: today, weightKg }],
    movingAverage7: [{ date: today, value: weightKg }],
    stats: { minKg: weightKg, maxKg: weightKg, latestKg: weightKg, changeKg: 0 },
    forecast: [],
    goalProgress: null,
  };
}

/** 以指定单位渲染 WeightPage，并记录所有 fetch 调用。 */
function renderWeightPage(unit: WeightUnit): { calls: Call[] } {
  useUnitStore.setState({ weightUnit: unit });
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      if (method === 'GET' && url.includes('/weights')) {
        return ok(trend(60));
      }
      return ok(null);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WeightPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls };
}

beforeEach(() => {
  window.localStorage.clear();
  cacheClearAll();
  __resetDirtyForTest();
  __resetMemoryQueueForTest();
  useUnitStore.setState({ unit: 'kcal', weightUnit: 'kg' });
  useAuthStore.setState({ accessToken: null });
  vi.unstubAllGlobals();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useUnitStore.setState({ unit: 'kcal', weightUnit: 'kg' });
  useAuthStore.setState({ accessToken: null });
  await clearQueuedRequests();
});

// ---------------------------------------------------------------------------
// ① 纯函数：双向 + 精确往返
// ---------------------------------------------------------------------------

describe('D-3 · 斤换算纯函数（1 kg = 2 市斤）', () => {
  it('kg → 斤 加倍；斤 → kg 减半；kg 模式恒等', () => {
    expect(JIN_PER_KG).toBe(2);
    expect(kgToJin(65.5)).toBe(131);
    expect(jinToKg(131)).toBe(65.5);
    expect(toDisplayWeight(60, 'jin')).toBe(120);
    expect(toDisplayWeight(60, 'kg')).toBe(60);
    expect(fromDisplayWeight(131, 'jin')).toBe(65.5);
    expect(fromDisplayWeight(60, 'kg')).toBe(60);
  });

  it('★ 往返不丢精度：kg → 斤 → kg 恒等（两种单位都测）', () => {
    for (const kg of [65.5, 59.8, 70, 100.1, 0.5, 123.4, 45.25]) {
      expect(fromDisplayWeight(toDisplayWeight(kg, 'jin'), 'jin')).toBe(kg);
      expect(fromDisplayWeight(toDisplayWeight(kg, 'kg'), 'kg')).toBe(kg);
    }
  });
});

// ---------------------------------------------------------------------------
// ② 显示双向（WeightPage 真实渲染）
// ---------------------------------------------------------------------------

describe('D-3 · 显示口径双向（WeightPage）', () => {
  it('kg 模式显示 60.0 kg；不出现「斤」口径', async () => {
    renderWeightPage('kg');
    await waitFor(() => expect(screen.getByText('60.0 kg')).toBeDefined());
    expect(screen.queryByText('120.0 斤')).toBeNull();
  });

  it('斤模式显示 120.0 斤（= 60 kg × 2）；不出现 kg 口径', async () => {
    renderWeightPage('jin');
    await waitFor(() => expect(screen.getByText('120.0 斤')).toBeDefined());
    expect(screen.queryByText('60.0 kg')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ③ ★ 输入回写：斤模式下输入，提交的 body 是 kg
// ---------------------------------------------------------------------------

describe('D-3 · 体重输入按当前单位理解并回写 kg', () => {
  it('★ 斤模式输入 131 → POST /weights body weightKg = 65.5（不是 131）', async () => {
    const { calls } = renderWeightPage('jin');

    const input = await screen.findByLabelText(/体重（斤）/);
    fireEvent.change(input, { target: { value: '131' } });
    fireEvent.click(screen.getByRole('button', { name: '记录今天的体重' }));

    await waitFor(() => expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toContain('/weights');
    expect(post?.body?.weightKg).toBe(65.5);
  });

  it('★ 目标卡：斤模式下回显 120（= 60 kg），输入 131 → PATCH /goals body currentWeightKg = 65.5', async () => {
    useUnitStore.setState({ weightUnit: 'jin' });
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        calls.push({ url, method, body });
        if (url.includes('/profile')) {
          return ok({
            profile: null,
            goal: { startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 },
            budget: null,
            warnings: [],
          });
        }
        return ok(null);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <GoalSettingsCard />
      </QueryClientProvider>,
    );

    const input = (await screen.findByTestId('goal-input-current')) as HTMLInputElement;
    // 60 kg 在斤模式下应回显为 120
    expect(input.value).toBe('120');

    fireEvent.change(input, { target: { value: '131' } });
    fireEvent.click(screen.getByRole('button', { name: COPY.goalSaveButton }));

    await waitFor(() => expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toContain('/goals');
    expect(patch?.body).toEqual({ currentWeightKg: 65.5 });
  });
});

// ---------------------------------------------------------------------------
// ④ ★ 登出清理（GAP-4 P0-1 式）
// ---------------------------------------------------------------------------

describe('D-3 · 登出清理体重单位偏好', () => {
  it('★ 登出后 localStorage 键被清、内存态复位 kg', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    useUnitStore.getState().setWeightUnit('jin');
    await waitFor(() => expect(window.localStorage.getItem(WEIGHT_UNIT_STORAGE_KEY)).toBe('jin'));
    expect(useUnitStore.getState().weightUnit).toBe('jin');

    useAuthStore.getState().clear();

    // 内存态复位是 fire-and-forget 的动态 import，等微任务落地
    await waitFor(() => expect(useUnitStore.getState().weightUnit).toBe('kg'));
    expect(window.localStorage.getItem(WEIGHT_UNIT_STORAGE_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ⑤ ★ 离线重推（P0-2）
// ---------------------------------------------------------------------------

describe('D-3 · 离线改体重单位 → 联网补推', () => {
  it('★ 离线改斤（落库失败）→ 标记 dirty；联网后补推，body 含 weightUnit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    useUnitStore.getState().setWeightUnit('jin');
    await waitFor(() => expect(hasPendingSettings()).toBe(true));
    expect(useUnitStore.getState().weightUnit).toBe('jin');

    // 恢复联网（显式接收 fetch 参数，便于断言 method/body）
    const fetchMock = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<{ ok: true; status: number; json: () => Promise<unknown> }> =>
        ok({ unit: 'kcal', weightUnit: 'jin', darkMode: false, fastingEnabled: false, waterGoalMl: 2000 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pushed = await flushPendingSettings({ weightUnit: useUnitStore.getState().weightUnit });
    expect(pushed).toBe(true);
    expect(hasPendingSettings()).toBe(false);

    const patchCall = fetchMock.mock.calls.find(
      (call) => String(call[1]?.method ?? 'GET').toUpperCase() === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ weightUnit: 'jin' });
  });
});

// ---------------------------------------------------------------------------
// ⑥ 顶栏按钮
// ---------------------------------------------------------------------------

describe('D-3 · 顶栏体重单位切换按钮', () => {
  it('★ 顶栏有三个切换按钮，体重按钮可在 kg ↔ 斤 间切换并写本地偏好', async () => {
    useUnitStore.setState({ unit: 'kcal', weightUnit: 'kg' });
    render(
      <MemoryRouter>
        <AppShell>
          <p>内容</p>
        </AppShell>
      </MemoryRouter>,
    );

    // 热量 + 体重 + 深色 三个切换按钮并存
    expect(screen.getByRole('button', { name: /切换热量单位/ })).toBeDefined();
    const weightButton = screen.getByRole('button', { name: /切换体重单位/ });
    expect(screen.getByRole('button', { name: /切换到.*模式/ })).toBeDefined();
    expect(weightButton.textContent).toBe('kg');

    fireEvent.click(weightButton);

    expect(useUnitStore.getState().weightUnit).toBe('jin');
    expect(window.localStorage.getItem(WEIGHT_UNIT_STORAGE_KEY)).toBe('jin');
    expect(screen.getByRole('button', { name: /切换体重单位/ }).textContent).toBe('斤');
  });
});

// ---------------------------------------------------------------------------
// ⑦ 文案红线
// ---------------------------------------------------------------------------

describe('D-3 · 体重单位相关文案红线（PRD §7 无负罪感）', () => {
  const BANNED = ['失败', '错误', '崩溃', '出错', '超标', '过量'];

  it('单位感知文案不含禁用词', () => {
    const texts = [
      weightInputLabel('jin'),
      goalCurrentWeightLabel('jin'),
      goalTargetWeightLabel('jin'),
      goalRemainingLine(2.5, 'jin'),
      goalTargetLine(55, 'jin'),
      goalBaselineLine(60, 55, 'jin'),
      plateauStalledLine(21, 'jin'),
      plateauSlopeLine(0.38, 'jin'),
      periodWeightDownLine(-2.3, 'jin'),
      periodWeightUpLine(0.4, 'jin'),
      weightInputLabel('kg'),
      goalRemainingLine(2.5, 'kg'),
    ];
    for (const text of texts) {
      for (const banned of BANNED) {
        expect(text).not.toContain(banned);
      }
    }
  });

  it('斤模式下页面无红色恐吓类名', async () => {
    renderWeightPage('jin');
    await screen.findByText('120.0 斤');
    expect(document.body.innerHTML).not.toMatch(/text-red|bg-red|border-red|ring-red/);
  });
});
