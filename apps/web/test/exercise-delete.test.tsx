/**
 * 运动记录删除测试（GAP-5，pages/exercise/ExercisePage.tsx）。
 *
 * 本仓「删除类操作」既有惯例（照抄，不发明新 UI）：
 * - 单条删除 = 行内文字按钮、**无二次确认**（与 meal / water / win 三处一致）；
 * - 成功 → 轻描淡写的过去式反馈；业务错误 → 中性陈述（不用「失败 / 错误」）；
 * - 离线 → 入离线队列 + 本地先移除（同 WinLogCard 的 DELETE 路径）。
 *
 * ★ 本文件最要紧的一条：删除后**列表与 totalKcal 必须一致** ——
 *   只把 logs 过滤掉而留着旧 totalKcal，会留下「下面少一条、上面合计没变」的自相矛盾。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ExercisePage from '@/pages/exercise/ExercisePage';
import { COPY } from '@/lib/copy';
import { __resetMemoryQueueForTest, listQueuedRequests } from '@/pwa/offline-queue';

/** 一条运动记录（`GET /exercises` 的 logs 元素）。 */
interface ExLog {
  id: number;
  activityName: string;
  minutes: number;
  kcalBurned: number;
}

/** 造一份 `GET /exercises` 响应：totalKcal 由 logs 求和（与后端同口径）。 */
function makeDay(logs: ExLog[], date: string): { date: string; logs: ExLog[]; totalKcal: number } {
  const totalKcal = Math.round(logs.reduce((sum, log) => sum + log.kcalBurned, 0) * 10) / 10;
  return { date, logs, totalKcal };
}

/**
 * fetch 桩：覆盖 ExercisePage 会发的三种请求
 * （`GET /exercises`、`POST /exercises`、`DELETE /exercises/:id`，以及 `GET /water`）。
 */
function stubFetch(options: {
  logs: ExLog[];
  failDelete?: boolean;
  deleteError?: { status: number; code: string; message: string };
}): { calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';

      if (method === 'GET' && url.includes('/api/water')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { date: '2026-09-23', totalMl: 0, goalMl: 2000, logs: [] }, error: null }),
        } as Response;
      }
      if (method === 'GET' && url.includes('/api/exercises')) {
        calls.push({ url, method });
        const date = new URL(url, 'http://x').searchParams.get('date') ?? '2026-09-23';
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: makeDay(options.logs, date), error: null }),
        } as Response;
      }
      if (method === 'DELETE' && url.includes('/api/exercises/')) {
        calls.push({ url, method });
        const deleteError = options.deleteError;
        if (deleteError !== undefined) {
          return {
            ok: false,
            status: deleteError.status,
            json: async () => ({
              data: null,
              error: { code: deleteError.code, message: deleteError.message },
            }),
          } as Response;
        }
        if (options.failDelete) {
          throw new TypeError('Failed to fetch');
        }
        return { ok: true, status: 200, json: async () => ({ data: { deleted: true }, error: null }) } as Response;
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

describe('运动记录删除（GAP-5）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    __resetMemoryQueueForTest();
    window.localStorage.clear();
  });

  it('每条运动记录都有删除按钮，点击调 DELETE /exercises/:id', async () => {
    const { calls } = stubFetch({
      logs: [
        { id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 },
        { id: 12, activityName: '慢跑', minutes: 20, kcalBurned: 140 },
      ],
    });
    renderPage();

    const button = await waitFor(() => screen.getByTestId('exercise-delete-11'));
    fireEvent.click(button);

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE' && call.url.includes('/api/exercises/11'))).toBe(true);
    });
  });

  it('删除无二次确认（window.confirm 不被调用）', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    stubFetch({ logs: [{ id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 }] });
    renderPage();

    fireEvent.click(await waitFor(() => screen.getByTestId('exercise-delete-11')));

    await waitFor(() => {
      expect(screen.getByTestId('exercise-delete-11')).toBeDefined();
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('删除成功后该条从列表消失，且反馈为「已经删掉了」', async () => {
    stubFetch({
      logs: [
        { id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 },
        { id: 12, activityName: '慢跑', minutes: 20, kcalBurned: 140 },
      ],
    });
    renderPage();

    fireEvent.click(await waitFor(() => screen.getByTestId('exercise-delete-11')));

    await waitFor(() => {
      expect(screen.queryByTestId('exercise-delete-11')).toBeNull();
    });
    expect(screen.getByTestId('exercise-delete-12')).toBeDefined();
    expect(screen.getByText(COPY.exerciseDeleted)).toBeDefined();
  });

  it('★ 删除后 totalKcal 与列表一致（不是只把请求发出去了）', async () => {
    stubFetch({
      logs: [
        { id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 },
        { id: 12, activityName: '慢跑', minutes: 20, kcalBurned: 140 },
      ],
    });
    renderPage();

    // 初始合计 230
    await waitFor(() => {
      expect(screen.getByText('230')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('exercise-delete-11'));

    // 删掉 90 那条后，合计必须变成 140（= 列表里剩下那条的和），而不是仍显示 230
    await waitFor(() => {
      expect(screen.getByText('140')).toBeDefined();
    });
    expect(screen.queryByText('230')).toBeNull();
  });

  it('离线删除 → 入队 DELETE /exercises/:id + 本地先移除 + totalKcal 同步变小', async () => {
    stubFetch({
      logs: [
        { id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 },
        { id: 12, activityName: '慢跑', minutes: 20, kcalBurned: 140 },
      ],
      failDelete: true,
    });
    renderPage();

    fireEvent.click(await waitFor(() => screen.getByTestId('exercise-delete-11')));

    await waitFor(() => {
      expect(screen.getByText(COPY.exerciseDeleted)).toBeDefined();
    });
    expect(screen.queryByTestId('exercise-delete-11')).toBeNull();
    // 离线乐观移除同样要重算合计
    expect(screen.getByText('140')).toBeDefined();

    const queued = await listQueuedRequests();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.path).toBe('/exercises/11');
    expect(queued[0]?.method).toBe('DELETE');
  });

  it('业务错误（404）→ 中性陈述，不含「失败 / 错误」，且不入离线队列', async () => {
    stubFetch({
      logs: [{ id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 }],
      deleteError: { status: 404, code: 'E_NOTFOUND_EXERCISE', message: '没有找到这条运动记录' },
    });
    renderPage();

    fireEvent.click(await waitFor(() => screen.getByTestId('exercise-delete-11')));

    await waitFor(() => {
      expect(screen.getByText(COPY.exerciseDeleteMissed)).toBeDefined();
    });
    for (const banned of ['失败', '错误', '警告', '请重试']) {
      expect(COPY.exerciseDeleteMissed).not.toContain(banned);
    }
    // 业务错误不入离线队列（重放也没用）
    expect(await listQueuedRequests()).toHaveLength(0);
    // 记录仍在（没被乐观移除）
    expect(screen.getByTestId('exercise-delete-11')).toBeDefined();
  });

  it('文案红线：删除按钮与反馈不含「失败 / 错误」作标题，也无红色类名', async () => {
    stubFetch({ logs: [{ id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 }] });
    renderPage();

    const button = await waitFor(() => screen.getByTestId('exercise-delete-11'));
    // 静止态非红色（hover 才 coral）
    expect(button.className).not.toContain('text-red');
    expect(button.className).not.toContain('bg-red');
    for (const banned of ['失败', '错误', '崩溃']) {
      expect(button.textContent ?? '').not.toContain(banned);
      expect(COPY.exerciseDeleted).not.toContain(banned);
      expect(COPY.exerciseDeleteMissed).not.toContain(banned);
    }
  });
});
