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
 * QA 独立证伪（software-qa-engineer-4）—— C9 离线队列「毒消息不再堵死」。
 *
 * 与工程师用例互补，覆盖更刁钻的形态：
 * - 毒消息 + **多条**健康请求 → 一次 flush 全部同步（不止一条）；
 * - 毒消息夹在中间（good / bad / good）→ 两侧都同步；
 * - **按条目**（id）而非按路径计数：两条不同路径各失败 2 次、第 3 次各丢各的；
 * - 丢弃后 failure 计数清零：同路径再入队一条新请求仍能同步。
 */

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

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

describe('QA · flushQueue 毒消息隔离（C9）', () => {
  it('1 条毒消息 + 3 条健康请求 → 健康的全同步，毒消息留下', async () => {
    await enqueueRequest({ path: '/meals/reorder', method: 'PATCH', body: { bad: true } });
    await enqueueRequest({ path: '/weights', method: 'POST', body: { weightKg: 1 } });
    await enqueueRequest({ path: '/weights', method: 'POST', body: { weightKg: 2 } });
    await enqueueRequest({ path: '/meals', method: 'POST', body: { customName: 'x', customKcal: 10 } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/meals/reorder') ? badRequest('E_NOTFOUND_MEAL', '没有找到这条记录') : ok({ id: 1 }),
      ),
    );

    const result = await flushQueue();
    expect(result.synced).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.dropped).toBe(0);
    expect(result.remaining).toBe(1);

    const left = await listQueuedRequests();
    expect(left.map((entry) => entry.path)).toEqual(['/meals/reorder']);
  });

  it('毒消息夹在中间（good / bad / good）→ 两侧都同步', async () => {
    await enqueueRequest({ path: '/weights', method: 'POST', body: { n: 1 } });
    await enqueueRequest({ path: '/meals/reorder', method: 'PATCH', body: { bad: true } });
    await enqueueRequest({ path: '/weights', method: 'POST', body: { n: 2 } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/meals/reorder') ? badRequest('E_NOTFOUND_MEAL', 'x') : ok({ id: 1 }),
      ),
    );

    const result = await flushQueue();
    expect(result.synced).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.remaining).toBe(1);
  });

  it('失败计数按「条目 id」而非路径：两条不同路径各自第 3 次被丢弃', async () => {
    await enqueueRequest({ path: '/meals/reorder', method: 'PATCH', body: { bad: 1 } });
    await enqueueRequest({ path: '/wins', method: 'POST', body: { bad: 2 } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => badRequest('E_VALID_INPUT', '不对')),
    );

    // 前两轮：两条都只跳过
    const first = await flushQueue();
    expect(first.skipped).toBe(2);
    expect(first.dropped).toBe(0);
    expect(first.remaining).toBe(2);

    const second = await flushQueue();
    expect(second.dropped).toBe(0);
    expect(second.remaining).toBe(2);

    // 第三轮：两条各自达到上限 → 都被丢弃
    const third = await flushQueue();
    expect(third.dropped).toBe(2);
    expect(third.remaining).toBe(0);
    expect(MAX_FLUSH_ATTEMPTS).toBe(3);
  });

  it('毒消息被丢弃后，同路径新入队的请求仍能同步（计数已清零）', async () => {
    await enqueueRequest({ path: '/wins', method: 'POST', body: { text: '毒' } });
    vi.stubGlobal('fetch', vi.fn(async () => badRequest('E_VALID_INPUT', '毒')));
    for (let i = 0; i < MAX_FLUSH_ATTEMPTS; i += 1) {
      await flushQueue();
    }
    expect(await listQueuedRequests()).toHaveLength(0);

    // 换一条同路径的「健康」请求：fetch 现在成功
    vi.stubGlobal('fetch', vi.fn(async () => ok({ id: 7 })));
    await enqueueRequest({ path: '/wins', method: 'POST', body: { text: '健康' } });
    const result = await flushQueue();
    expect(result.synced).toBe(1);
    expect(result.remaining).toBe(0);
  });

  it('网络错误优先于业务错误计数：网络错误本轮不增加任何条目的失败计数', async () => {
    await enqueueRequest({ path: '/meals/reorder', method: 'PATCH', body: { bad: true } });

    // 网络不可达（抛异常 → E_NETWORK）
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    for (let i = 0; i < 5; i += 1) {
      const result = await flushQueue();
      expect(result.dropped).toBe(0);
    }
    // 网络错误不该把条目当成「业务错误」累计而误丢
    expect(await listQueuedRequests()).toHaveLength(1);
  });
});
