/**
 * 饮水快捷记录（+250ml）业务错误提示测试（缺陷收尾 · 项 4）。
 *
 * 背景：`addWater` / `undoWater` 的 `onError` 此前**无条件静默**（本意是「离线时静默落到
 * 本地缓存」），但静默不分流会把**业务错误**（4xx/5xx）也吞掉 —— 用户点「+250ml」后
 * 本地那 +250 不显示（`waterTotal` 取的是服务端旧值）、又没有任何提示，看起来像
 * 「点了没反应」，于是反复点。
 *
 * 本用例钉死分流（照抄同页 `logExercise` / `deleteExercise` 的既有写法）：
 * - 业务错误 → **给一句中性提示**（不是静默）；
 * - 网络错误 → **仍走原路径**（静默，本地缓存已先加）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ExercisePage from '@/pages/exercise/ExercisePage';
import { COPY } from '@/lib/copy';
import { __resetMemoryQueueForTest } from '@/pwa/offline-queue';

interface Call {
  method: string;
  url: string;
}

/** fetch 桩：覆盖 GET /water、GET /exercises、POST /water 三种请求。 */
function stubFetch(mode: 'ok' | 'business' | 'network'): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url });

      if (method === 'GET' && url.includes('/api/water')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { date: '2026-09-23', totalMl: 0, goalMl: 2000, logs: [] }, error: null }),
        } as Response;
      }
      if (method === 'GET' && url.includes('/api/exercises')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { date: '2026-09-23', logs: [], totalKcal: 0 }, error: null }),
        } as Response;
      }
      if (method === 'POST' && url.includes('/api/water')) {
        if (mode === 'network') {
          throw new TypeError('Failed to fetch');
        }
        if (mode === 'business') {
          return {
            ok: false,
            status: 500,
            json: async () => ({
              data: null,
              error: { code: 'E_SERVER', message: '服务端在开小差，稍后我们再来一次' },
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { date: '2026-09-23', totalMl: 250, goalMl: 2000, logs: [{ id: 1, amountMl: 250 }] },
            error: null,
          }),
        } as Response;
      }
      throw new Error(`测试桩未覆盖的请求：${method} ${url}`);
    }),
  );
  return { calls };
}

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/exercise']}>
        <ExercisePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('饮水快捷记录 · 错误分流（项 4）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    __resetMemoryQueueForTest();
    window.localStorage.clear();
  });

  it('业务错误（500）→ 给中性提示（不是静默）', async () => {
    stubFetch('business');
    renderPage();

    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: '+250ml' })));

    await waitFor(() => {
      expect(screen.getByText(COPY.waterAddMissed)).toBeInTheDocument();
    });
    // 语气红线：中性，不含「失败 / 错误 / 崩溃」
    for (const banned of ['失败', '错误', '崩溃']) {
      expect(COPY.waterAddMissed).not.toContain(banned);
    }
  });

  it('网络错误 → 仍走原路径（静默，不给业务错误提示）', async () => {
    const { calls } = stubFetch('network');
    renderPage();

    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: '+250ml' })));

    // 确认 POST /water 确实发了（点击被处理了）
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST' && call.url.includes('/api/water'))).toBe(true);
    });
    // 网络错误不分流到业务提示（本地缓存已先 +250，联网后再同步）
    expect(screen.queryByText(COPY.waterAddMissed)).toBeNull();
  });
});
