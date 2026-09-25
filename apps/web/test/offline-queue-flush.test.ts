import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_FLUSH_ATTEMPTS,
  __resetMemoryQueueForTest,
  clearQueuedRequests,
  enqueueRequest,
  flushQueue,
  listQueuedRequests,
} from '@/pwa/offline-queue';

/**
 * 离线队列冲队（flushQueue）—— P0-5 回归。
 *
 * 钉死修复前会「永久堵死」离线能力的三条不变量：
 * ① **一条业务错误（毒消息）不得拖累后面的健康请求**（旧实现首错即 `break`）；
 * ② 网络层错误应当**停止本轮**（避免对每条都白试一次），且条目全部保留；
 * ③ 同一路径连续失败达上限后**丢弃**，不再被永久重试。
 */

/** 成功响应包装。 */
function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

/** HTTP 可达但业务失败（非网络层错误）。 */
function badRequest(code: string, message: string): {
  ok: false;
  status: number;
  json: () => Promise<unknown>;
} {
  return { ok: false, status: 400, json: async () => ({ data: null, error: { code, message } }) };
}

beforeEach(async () => {
  __resetMemoryQueueForTest();
  await clearQueuedRequests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('flushQueue（P0-5）', () => {
  it('① 一条业务错误不阻塞后面的健康请求（跳过并计数）', async () => {
    // 毒消息先入队（引用的记录已不存在 → 服务端 400/404 业务错误）
    await enqueueRequest({ path: '/meals/reorder', method: 'PATCH', body: { bad: true } });
    await enqueueRequest({ path: '/weights', method: 'POST', body: { weightKg: 60 } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/meals/reorder')) {
          return badRequest('E_NOTFOUND_MEAL', '没有找到这条记录');
        }
        return ok({ id: 1 });
      }),
    );

    const result = await flushQueue();

    // 健康请求被同步（证明没有被毒消息堵住）
    expect(result.synced).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.dropped).toBe(0);
    expect(result.remaining).toBe(1);

    const queued = await listQueuedRequests();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.path).toBe('/meals/reorder');
  });

  it('② 网络层错误 → 本轮停止（只试一次），条目全部保留', async () => {
    await enqueueRequest({ path: '/meals', method: 'POST', body: { a: 1 } });
    await enqueueRequest({ path: '/weights', method: 'POST', body: { weightKg: 60 } });

    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await flushQueue();

    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.dropped).toBe(0);
    expect(result.remaining).toBe(2);
    // 网络不可达时不该对每条都白试一次 —— 首条失败即结束本轮
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await listQueuedRequests()).toHaveLength(2);
  });

  it('③ 同一条连续失败达上限后被丢弃（不再永久重试）', async () => {
    await enqueueRequest({ path: '/meals/reorder', method: 'PATCH', body: { bad: true } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => badRequest('E_NOTFOUND_MEAL', '没有找到这条记录')),
    );

    // 前两轮：只跳过，不丢弃
    const first = await flushQueue();
    expect(first.skipped).toBe(1);
    expect(first.dropped).toBe(0);
    expect(first.remaining).toBe(1);

    const second = await flushQueue();
    expect(second.dropped).toBe(0);
    expect(second.remaining).toBe(1);

    // 第三轮（达到 MAX_FLUSH_ATTEMPTS）：丢弃毒消息
    const third = await flushQueue();
    expect(third.dropped).toBe(1);
    expect(third.remaining).toBe(0);
    expect(MAX_FLUSH_ATTEMPTS).toBe(3);
  });
});
