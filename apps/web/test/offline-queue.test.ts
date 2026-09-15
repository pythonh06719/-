import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetMemoryQueueForTest,
  clearQueuedRequests,
  enqueueRequest,
  listQueuedRequests,
  queueLength,
  removeQueuedRequest,
} from '@/pwa/offline-queue';

/**
 * 离线队列（jsdom 无 IndexedDB → 自动降级内存实现，逻辑仍可测）。
 *
 * 覆盖：入队顺序、移除、清空、长度（TC-47 / Q7）。
 */
describe('offline-queue', () => {
  beforeEach(async () => {
    __resetMemoryQueueForTest();
    await clearQueuedRequests();
  });

  it('入队后按时间顺序列出', async () => {
    await enqueueRequest({ path: '/meals', method: 'POST', body: { a: 1 } });
    await enqueueRequest({ path: '/weights', method: 'POST', body: { weightKg: 60 } });

    const queued = await listQueuedRequests();
    expect(queued).toHaveLength(2);
    expect(queued[0]?.path).toBe('/meals');
    expect(queued[1]?.path).toBe('/weights');
    expect(await queueLength()).toBe(2);
  });

  it('可按 id 移除单条', async () => {
    const first = await enqueueRequest({ path: '/meals', method: 'POST' });
    await enqueueRequest({ path: '/weights', method: 'POST' });

    await removeQueuedRequest(first.id);
    const queued = await listQueuedRequests();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.path).toBe('/weights');
  });

  it('清空后长度为 0', async () => {
    await enqueueRequest({ path: '/meals', method: 'POST' });
    await clearQueuedRequests();
    expect(await queueLength()).toBe(0);
  });
});
