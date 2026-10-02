/**
 * 每日饮水目标编辑入口（GAP-3，pages/exercise/WaterGoalCard.tsx）。
 *
 * ## 背景
 *
 * `waterGoalMl` 的后端两条通道都就绪（范围对齐到 500–8000），前端却**没有输入入口**，
 * 用户永远看 2000 默认值。本文件把补上的入口契约固定下来：
 *
 * - **展示**：入口回显当前值（来自 `GET /water` 的 `goalMl`），不是硬编码 2000；
 * - **核心**：改目标 → `PATCH /users/settings` 且 body 含正确的 `waterGoalMl`；
 * - **范围**：499 / 8001 → 前端拦住（不发出请求），给中性提示；
 * - **离线**：改目标失败 → 记 dirty、本地先记住、不报错、不阻塞；联网后补推。
 *
 * 手法：mock 全局 `fetch`（与 `settings-sync.test.tsx` / `exercise-delete.test.tsx` 一致），
 * 断言实际请求 URL / method / body，而不是断言内部实现。
 *
 * 语气红线（PRD §7）：新文案不含「失败 / 错误」作标题，无红色类名，无催促性措辞。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import ExercisePage from '@/pages/exercise/ExercisePage';
import { COPY, waterGoalInvalidFor } from '@/lib/copy';
import { DEFAULT_WATER_GOAL_ML, WATER_GOAL_MAX_ML, WATER_GOAL_MIN_ML } from '@qsh/core';
import { createEmptyExportPayload } from '@/lib/csv';
import { __resetDirtyForTest, flushPendingSettings, hasPendingSettings } from '@/lib/settings-sync';
import { WATER_GOAL_STORAGE_KEY, readStoredWaterGoalMl } from '@/lib/water-goal';

/** 统一 `{ data, error }` 包装的成功响应。 */
function wrappedResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) } as unknown as Response;
}

interface FetchRecord {
  url: string;
  method: string;
  body: unknown;
}

/**
 * fetch 桩：覆盖 ExercisePage 会发的请求（`GET /water`、`GET /exercises`）
 * 以及饮水目标落库的 `PATCH /users/settings`。
 */
function stubFetch(options: { goalMl?: number; failPatch?: boolean } = {}): {
  calls: FetchRecord[];
} {
  const calls: FetchRecord[] = [];
  const goalMl = options.goalMl ?? 2000;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body =
        init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
      calls.push({ url, method, body });

      if (url.includes('/api/users/settings')) {
        if (options.failPatch) {
          throw new TypeError('Failed to fetch');
        }
        return wrappedResponse({ unit: 'kcal', waterGoalMl: goalMl });
      }
      if (method === 'GET' && url.includes('/api/water')) {
        return wrappedResponse({ date: '2026-09-23', totalMl: 0, goalMl, logs: [] });
      }
      if (method === 'GET' && url.includes('/api/exercises')) {
        return wrappedResponse({ date: '2026-09-23', logs: [], totalKcal: 0 });
      }
      throw new Error(`测试桩未覆盖的请求：${method} ${url}`);
    }),
  );
  return { calls };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/exercise']}>
        <ExercisePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 从 fetch 记录里筛出 PATCH `/api/users/settings` 的调用体。 */
function patchBodies(calls: FetchRecord[]): unknown[] {
  return calls
    .filter((call) => call.method === 'PATCH' && call.url.includes('/api/users/settings'))
    .map((call) => call.body);
}

function inputEl(): HTMLInputElement {
  return screen.getByTestId('water-goal-input') as HTMLInputElement;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  __resetDirtyForTest();
});

describe('GAP-3：每日饮水目标编辑入口（落点 /exercise 喝水区）', () => {
  it('★ 展示：入口回显当前目标（GET /water 的 goalMl），不是硬编码 2000', async () => {
    stubFetch({ goalMl: 2500 });
    renderPage();

    await waitFor(() => {
      expect(inputEl().value).toBe('2500');
    });
    // 2000 是被改掉的目标，不应再出现
    expect(inputEl().value).not.toBe('2000');
  });

  it('★ 核心：改目标 → PATCH /users/settings 且 body 含正确的 waterGoalMl', async () => {
    const { calls } = stubFetch({ goalMl: 2000 });
    renderPage();

    // 等入口就绪
    await waitFor(() => {
      expect(inputEl().value).toBe('2000');
    });

    fireEvent.change(inputEl(), { target: { value: '2600' } });
    fireEvent.click(screen.getByText(COPY.waterGoalButton));

    await waitFor(() => {
      expect(patchBodies(calls).length).toBeGreaterThan(0);
    });
    expect(patchBodies(calls)[0]).toEqual({ waterGoalMl: 2600 });
    // 本地快路径同步记住（离线展示 + 联网补推的来源）
    expect(readStoredWaterGoalMl()).toBe(2600);
    expect(window.localStorage.getItem(WATER_GOAL_STORAGE_KEY)).toBe('2600');
  });

  it('★ 范围：499 → 前端拦住（不发出请求），给中性提示', async () => {
    const { calls } = stubFetch({ goalMl: 2000 });
    renderPage();
    await waitFor(() => expect(inputEl().value).toBe('2000'));

    fireEvent.change(inputEl(), { target: { value: '499' } });
    fireEvent.click(screen.getByText(COPY.waterGoalButton));

    await waitFor(() => {
      expect(screen.getByTestId('water-goal-notice')).toBeInTheDocument();
    });
    expect(patchBodies(calls)).toHaveLength(0);
    expect(screen.getByTestId('water-goal-notice').textContent).toBe(
      waterGoalInvalidFor(WATER_GOAL_MIN_ML, WATER_GOAL_MAX_ML),
    );
    // 未落库也未写本地
    expect(readStoredWaterGoalMl()).toBeUndefined();
  });

  it('★ 范围：8001 → 前端拦住（不发出请求）', async () => {
    const { calls } = stubFetch({ goalMl: 2000 });
    renderPage();
    await waitFor(() => expect(inputEl().value).toBe('2000'));

    fireEvent.change(inputEl(), { target: { value: '8001' } });
    fireEvent.click(screen.getByText(COPY.waterGoalButton));

    await waitFor(() => {
      expect(screen.getByTestId('water-goal-notice')).toBeInTheDocument();
    });
    expect(patchBodies(calls)).toHaveLength(0);
  });

  it('边界值 500 / 8000 合法，会发出请求', async () => {
    const { calls } = stubFetch({ goalMl: 2000 });
    renderPage();
    await waitFor(() => expect(inputEl().value).toBe('2000'));

    fireEvent.change(inputEl(), { target: { value: '500' } });
    fireEvent.click(screen.getByText(COPY.waterGoalButton));

    await waitFor(() => {
      expect(patchBodies(calls)).toContainEqual({ waterGoalMl: 500 });
    });
  });

  it('★ 离线：改目标失败 → 本地先记住 + 记 dirty（不抛错、不阻塞）', async () => {
    stubFetch({ goalMl: 2000, failPatch: true });
    renderPage();
    await waitFor(() => expect(inputEl().value).toBe('2000'));

    expect(() => {
      fireEvent.change(inputEl(), { target: { value: '3000' } });
      fireEvent.click(screen.getByText(COPY.waterGoalButton));
    }).not.toThrow();

    // 首次 + 一次重试后仍失败 → 记 dirty
    await waitFor(() => {
      expect(hasPendingSettings()).toBe(true);
    });
    // 本地已生效（离线显示与补推的来源）
    expect(readStoredWaterGoalMl()).toBe(3000);
    expect(window.localStorage.getItem(WATER_GOAL_STORAGE_KEY)).toBe('3000');
  });

  it('★ 联网后补推：把本机记住的目标推回服务端，且 dirty 清除', async () => {
    // 先离线改（制造 dirty）
    stubFetch({ goalMl: 2000, failPatch: true });
    renderPage();
    await waitFor(() => expect(inputEl().value).toBe('2000'));
    fireEvent.change(inputEl(), { target: { value: '3000' } });
    fireEvent.click(screen.getByText(COPY.waterGoalButton));
    await waitFor(() => expect(hasPendingSettings()).toBe(true));

    // 联网：后续请求成功
    const { calls } = stubFetch({ goalMl: 3000 });
    // 与 App 的 registerSettingsOnlineFlush(getCurrent) 同构：从本机读到当前值再推
    const pushed = await flushPendingSettings({ waterGoalMl: readStoredWaterGoalMl() });

    expect(pushed).toBe(true);
    expect(patchBodies(calls)).toContainEqual({ waterGoalMl: 3000 });
    expect(hasPendingSettings()).toBe(false);
  });

  it('文案红线：新文案不含「失败 / 错误 / 警告」作标题，无红色类名，无催促性措辞', async () => {
    stubFetch({ goalMl: 2000 });
    renderPage();
    await waitFor(() => expect(inputEl().value).toBe('2000'));

    for (const banned of ['失败', '错误', '警告', '崩溃']) {
      expect(COPY.waterGoalTitle).not.toContain(banned);
      expect(COPY.waterGoalDesc).not.toContain(banned);
      expect(COPY.waterGoalButton).not.toContain(banned);
      expect(COPY.waterGoalSaved).not.toContain(banned);
    }
    // 无催促性措辞
    for (const pressured of ['必须', '一定', '坚持', '赶紧']) {
      expect(COPY.waterGoalDesc).not.toContain(pressured);
      expect(COPY.waterGoalSaved).not.toContain(pressured);
    }
    // 卡片内无红色 / coral 类名（饮水是轻设置，不恐吓）
    const card = screen.getByRole('heading', { name: COPY.waterGoalTitle }).closest('section');
    expect(card).not.toBeNull();
    const classNames = card === null ? '' : (card as HTMLElement).innerHTML;
    expect(classNames).not.toContain('text-red');
    expect(classNames).not.toContain('bg-red');
    expect(classNames).not.toContain('coral');
  });
});

describe('GAP-3：waterGoalMl 纳入导出骨架（连带）', () => {
  it('createEmptyExportPayload 的 settings 含 waterGoalMl 默认值', () => {
    const payload = createEmptyExportPayload('2026-09-12T00:00:00.000Z');
    expect(payload.settings.waterGoalMl).toBe(DEFAULT_WATER_GOAL_ML);
  });
});
