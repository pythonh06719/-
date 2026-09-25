import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WinLogCard from '@/pages/weight/WinLogCard';
import { COPY } from '@/lib/copy';
import { __resetMemoryQueueForTest, listQueuedRequests } from '@/pwa/offline-queue';
import type { WinLog } from '@qsh/shared-types';

/**
 * QA 独立证伪（software-qa-engineer-4）—— C10 WinLogCard。
 *
 * 与工程师用例互补，重点独立验证「只有 `isNetworkError` 才入队」这条边界：
 * - POST **业务错误（400）** → **不入队**、显示服务端文案、输入不丢；
 * - GET 失败 → 错误态文案（不再冒充空态）；
 * - 删除业务错误 → 不入队 + 中性文案。
 */

function makeWin(id: number, text: string): WinLog {
  return {
    id,
    userId: 1,
    loggedDate: '2026-09-23',
    text,
    createdAt: '2026-09-23T08:00:00.000Z',
    updatedAt: '2026-09-23T08:00:00.000Z',
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function renderCard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WinLogCard />
    </QueryClientProvider>,
  );
}

async function typeAndSubmit(text: string): Promise<void> {
  fireEvent.change(screen.getByTestId('win-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('win-submit'));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  __resetMemoryQueueForTest();
});

describe('QA · WinLogCard 业务错误不入队（C10）', () => {
  it('POST 返回 400 业务错误 → 不入离线队列、提示服务端文案、输入保留', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        calls.push(method);
        if (method === 'GET') return jsonResponse(200, { data: [], error: null });
        // POST 业务错误（HTTP 可达，非网络层）
        return jsonResponse(400, {
          data: null,
          error: { code: 'E_VALID_INPUT', message: '这句太长啦，短一点就好' },
        });
      }),
    );
    renderCard();

    await waitFor(() => expect(screen.getByTestId('win-input')).toBeInTheDocument());
    await typeAndSubmit('一条会被服务端拒绝的内容');

    await waitFor(() => {
      expect(screen.getByTestId('win-notice').textContent).toBe('这句太长啦，短一点就好');
    });
    // 关键：业务错误绝不入队（重放只会一直失败，变毒消息）
    expect(await listQueuedRequests()).toHaveLength(0);
    // 输入内容保留，让用户修正
    expect((screen.getByTestId('win-input') as HTMLInputElement).value).toBe('一条会被服务端拒绝的内容');
  });

  it('POST 真离线（网络层）→ 入队 POST /wins + 提示已记下（还没同步）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET') return jsonResponse(200, { data: [], error: null });
        throw new TypeError('Failed to fetch'); // 网络层错误
      }),
    );
    renderCard();

    await waitFor(() => expect(screen.getByTestId('win-input')).toBeInTheDocument());
    await typeAndSubmit('离线也要记下来');

    await waitFor(() => expect(screen.getByTestId('win-notice').textContent).toBe(COPY.winCardOfflineSaved));
    const queued = await listQueuedRequests();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.path).toBe('/wins');
    expect(queued[0]?.method).toBe('POST');
    expect(queued[0]?.body).toEqual({ text: '离线也要记下来' });
  });

  it('GET 失败且无缓存 → 显示「读不到」，不显示空态「还没有记过」', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(500, { data: null, error: { code: 'E_HTTP_500', message: '服务端在开小差' } }),
      ),
    );
    renderCard();

    await waitFor(() => expect(screen.getByTestId('win-list-error')).toBeInTheDocument());
    expect(screen.queryByText(COPY.winCardListEmpty)).toBeNull();
  });

  it('删除业务错误（404）→ 不入队 + 中性文案（不含「失败/错误」）', async () => {
    const win = makeWin(7, '睡眠变好了');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET') return jsonResponse(200, { data: [win], error: null });
        return jsonResponse(404, { data: null, error: { code: 'E_NOTFOUND_WIN', message: '没有找到这条内容' } });
      }),
    );
    renderCard();

    const del = await waitFor(() => screen.getByTestId('win-delete-7'));
    fireEvent.click(del);

    await waitFor(() => expect(screen.getByTestId('win-notice').textContent).toBe(COPY.winCardDeleteFailed));
    expect(await listQueuedRequests()).toHaveLength(0);
    for (const banned of ['失败', '错误', '警告']) {
      expect(COPY.winCardDeleteFailed).not.toContain(banned);
    }
  });
});
