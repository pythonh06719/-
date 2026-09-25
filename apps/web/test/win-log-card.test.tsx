/**
 * 「体重之外的变化」卡测试（R11.4，pages/weight/WinLogCard.tsx）。
 *
 * 零压力口径（AC-11.4.1 / 11.4.2 / 11.4.4 / 11.4.9）：
 * - 失焦且未输入 → **静默无反馈**（不报错、不提示、不发请求）；
 * - 无必填校验：空提交 → 静默忽略，不发 POST；
 * - 超 60 字 → 中性说明（不阻断输入），提交被拦截且不截断；
 * - 离线提交 → 入离线队列（path `/wins`）+ 乐观插入一条临时记录 + 「已经记下啦（还没同步）」；
 * - 删除**无二次确认**（window.confirm 不被调用），离线删除同样入队 + 本地先移除；
 * - 无徽章 / 成就 / 连续等游戏化元素（AC-11.4.5）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WinLogCard from '@/pages/weight/WinLogCard';
import { COPY } from '@/lib/copy';
import { __resetMemoryQueueForTest, listQueuedRequests } from '@/pwa/offline-queue';
import type { WinLog } from '@qsh/shared-types';

/** 造一条服务端 WinLog。 */
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

/** fetch 桩：按 method + 路由匹配，可注入失败。 */
function stubFetch(options: {
  wins?: WinLog[];
  failPost?: boolean;
  failDelete?: boolean;
  /** GET 返回 HTTP 500（模拟「读不到」，用于 #8② 错误态文案） */
  failGet?: boolean;
  /** DELETE 返回 HTTP 可达的业务错误（用于 #8① 删除失败不再静默） */
  deleteError?: { status: number; code: string; message: string };
}): { calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      calls.push({ url, method });

      if (method === 'GET' && url.includes('/api/wins')) {
        if (options.failGet === true) {
          return {
            ok: false,
            status: 500,
            json: async () => ({
              data: null,
              error: { code: 'E_HTTP_500', message: '服务端在开小差，稍后我们再来一次' },
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: options.wins ?? [], error: null }),
        } as Response;
      }
      if (method === 'POST' && url.includes('/api/wins')) {
        if (options.failPost) {
          throw new TypeError('Failed to fetch');
        }
        const body = JSON.parse(String(init?.body)) as { text: string };
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: makeWin(101, body.text), error: null }),
        } as Response;
      }
      if (method === 'DELETE' && url.includes('/api/wins/')) {
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
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { deleted: true }, error: null }),
        } as Response;
      }
      throw new Error(`测试桩未覆盖的请求：${method} ${url}`);
    }),
  );
  return { calls };
}

function renderCard(wins: WinLog[] = []): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WinLogCard />
    </QueryClientProvider>,
  );
  // 占位引用避免未使用告警（wins 由 stub 闭包提供）
  void wins;
}

async function typeAndSubmit(text: string): Promise<void> {
  const input = screen.getByTestId('win-input');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByTestId('win-submit'));
}

describe('WinLogCard 零压力口径（R11.4）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    __resetMemoryQueueForTest();
  });

  it('失焦且未输入 → 静默无反馈、不发请求（AC-11.4.1）', async () => {
    const { calls } = stubFetch({ wins: [] });
    renderCard();

    const input = await waitFor(() => screen.getByTestId('win-input'));
    input.focus();
    fireEvent.blur(input);

    expect(screen.queryByTestId('win-notice')).toBeNull();
    expect(screen.queryByTestId('win-too-long')).toBeNull();
    // 只有初始 GET，没有 POST
    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    });
    expect(document.body.innerHTML).not.toContain('必填');
  });

  it('无必填校验：空文本提交 → 静默忽略，不发 POST（AC-11.4.1）', async () => {
    const { calls } = stubFetch({ wins: [] });
    renderCard();

    await typeAndSubmit('   '); // 纯空白 = 清洗后为空

    expect(screen.queryByTestId('win-notice')).toBeNull();
    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    });
  });

  it('超 60 字 → 中性说明出现；提交被拦截（不截断不发请求）', async () => {
    const { calls } = stubFetch({ wins: [] });
    renderCard();

    const input = screen.getByTestId('win-input');
    fireEvent.change(input, { target: { value: '好'.repeat(61) } });

    // 中性说明出现（不阻断输入：输入框仍可编辑）
    expect(screen.getByTestId('win-too-long').textContent).toBe(COPY.winCardTooLong);
    expect((screen.getByTestId('win-input') as HTMLInputElement).disabled).toBe(false);

    // 说明由输入内容派生：失焦不清除（清除的是失败提交留下的 notice），文本改短即消失
    fireEvent.blur(input);
    expect(screen.getByTestId('win-too-long')).toBeDefined();
    fireEvent.change(input, { target: { value: '好'.repeat(10) } });
    expect(screen.queryByTestId('win-too-long')).toBeNull();

    // 超限时提交被拦截：不发 POST
    fireEvent.change(input, { target: { value: '好'.repeat(61) } });
    fireEvent.click(screen.getByTestId('win-submit'));
    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    });
  });

  it('离线提交 → 入队 POST /wins + 乐观插入临时记录 + 「已经记下啦（还没同步）」（AC-11.4.9）', async () => {
    stubFetch({ wins: [], failPost: true });
    renderCard();

    await typeAndSubmit('今天爬楼没那么喘了');

    await waitFor(() => {
      expect(screen.getByTestId('win-notice').textContent).toBe(COPY.winCardOfflineSaved);
    });
    expect(screen.getByText('今天爬楼没那么喘了')).toBeDefined();

    const queued = await listQueuedRequests();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.path).toBe('/wins');
    expect(queued[0]?.method).toBe('POST');
    expect(queued[0]?.body).toEqual({ text: '今天爬楼没那么喘了' });
  });

  it('在线提交成功 → 「记下啦」提示、输入框清空', async () => {
    stubFetch({ wins: [] });
    renderCard();

    await typeAndSubmit('裤子松了一圈');

    await waitFor(() => {
      expect(screen.getByTestId('win-notice').textContent).toBe(COPY.winCardSaved);
    });
    expect((screen.getByTestId('win-input') as HTMLInputElement).value).toBe('');
  });

  it('删除无二次确认：window.confirm 不被调用（AC-11.4.4）', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const win = makeWin(7, '睡眠变好了');
    stubFetch({ wins: [win] });
    renderCard();

    const deleteButton = await waitFor(() => screen.getByTestId('win-delete-7'));
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(screen.getByTestId('win-notice').textContent).toBe(COPY.winCardDeleted);
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('离线删除 → 入队 DELETE /wins/:id + 本地先移除（AC-11.4.4 / AC-11.4.9）', async () => {
    const win = makeWin(7, '睡眠变好了');
    stubFetch({ wins: [win], failDelete: true });
    renderCard();

    const deleteButton = await waitFor(() => screen.getByTestId('win-delete-7'));
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(screen.getByTestId('win-notice').textContent).toBe(COPY.winCardDeleted);
    });
    expect(screen.queryByTestId('win-item-7')).toBeNull();

    const queued = await listQueuedRequests();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.path).toBe('/wins/7');
    expect(queued[0]?.method).toBe('DELETE');
  });

  it('列表空 → 中性空态「还没有记过，想起来就写一句」', async () => {
    stubFetch({ wins: [] });
    renderCard();

    await waitFor(() => {
      expect(screen.getByText(COPY.winCardListEmpty)).toBeDefined();
    });
  });

  // ---- 代码审查 #8 回归 ----

  it('#8② 读取失败 → 显示「暂时读不到」，**不得**误说成「还没有记过」', async () => {
    stubFetch({ wins: [], failGet: true });
    renderCard();

    await waitFor(() => {
      expect(screen.getByTestId('win-list-error').textContent).toBe(COPY.winCardListError);
    });
    // 语义相反：读不到 ≠ 没记过
    expect(screen.queryByText(COPY.winCardListEmpty)).toBeNull();
  });

  it('#8① 删除遇到业务错误 → 不再静默，给中性陈述（且不用「失败 / 错误」等词）', async () => {
    const win = makeWin(7, '睡眠变好了');
    stubFetch({
      wins: [win],
      deleteError: { status: 404, code: 'E_NOTFOUND_WIN', message: '没有找到这条内容' },
    });
    renderCard();

    const deleteButton = await waitFor(() => screen.getByTestId('win-delete-7'));
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(screen.getByTestId('win-notice').textContent).toBe(COPY.winCardDeleteFailed);
    });
    // 语气硬约束：中性陈述
    for (const banned of ['失败', '错误', '警告', '请重试']) {
      expect(COPY.winCardDeleteFailed).not.toContain(banned);
    }
    // 业务错误不入离线队列（重放也没用）
    expect(await listQueuedRequests()).toHaveLength(0);
  });

  it('#8③ 离线提交入队的是**本次提交的正文**，而非提交后又改动的输入框内容', async () => {
    const control: { rejectPost: ((reason?: unknown) => void) | null } = { rejectPost: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url.includes('/api/wins')) {
          return { ok: true, status: 200, json: async () => ({ data: [], error: null }) } as Response;
        }
        if (method === 'POST' && url.includes('/api/wins')) {
          // 挂起的 POST：由测试稍后手动以「网络错误」拒绝
          return new Promise<Response>((_resolve, reject) => {
            control.rejectPost = reject;
          });
        }
        throw new Error(`测试桩未覆盖的请求：${method} ${url}`);
      }),
    );
    renderCard();

    await typeAndSubmit('刚才提交的内容');
    // 提交在途时，用户又改了输入框
    fireEvent.change(screen.getByTestId('win-input'), { target: { value: '后来改的内容' } });

    await waitFor(() => {
      expect(control.rejectPost).not.toBeNull();
    });
    control.rejectPost?.(new TypeError('Failed to fetch'));

    await waitFor(() => {
      expect(screen.getByTestId('win-notice').textContent).toBe(COPY.winCardOfflineSaved);
    });

    const queued = await listQueuedRequests();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.body).toEqual({ text: '刚才提交的内容' }); // 关键：不是「后来改的内容」
    expect(screen.getByText('刚才提交的内容')).toBeDefined();
    expect(screen.queryByText('后来改的内容')).toBeNull();
  });

  it('无游戏化元素：整卡不出现 徽章/成就/等级/积分/连续/奖励/解锁/星级（AC-11.4.5）', async () => {
    stubFetch({ wins: [makeWin(7, '睡眠变好了')] });
    renderCard();

    await waitFor(() => {
      expect(screen.getByTestId('win-item-7')).toBeDefined();
    });
    const html = document.body.innerHTML;
    for (const banned of ['徽章', '成就', '等级', '积分', '连续', '奖励', '解锁', '星级', 'streak']) {
      expect(html).not.toContain(banned);
    }
  });
});
