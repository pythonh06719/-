/**
 * 离线队列待同步条数可见（GAP-9）—— 接线测试。
 *
 * 覆盖三件事：
 * ① **订阅机制**：`enqueueRequest` 之后条数变化能推给订阅者，退订后不再推；
 * ② **AppShell 横幅**：离线 + 有排队 → 显示「还有 N 笔…」；联网 + 队列空 → 横幅收起；
 *    联网但还有排队 → 显示「正在同步」；
 * ③ **同步完成 / 有丢弃**：条数归零 + 本轮 `dropped > 0` → 给一句软着陆说明
 *    （**不出现任何数字**、不出现「失败 / 丢失」）。
 *
 * ⚠️ 语气红线（PRD §7 / NFR-11）：全文案不得出现「同步失败 / 未同步 / 丢失 / 重试」，
 * 也不得出现被丢弃的**条数** —— 有专门的用例把它钉死。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AppShell, { deriveSyncNotice } from '@/components/layout/AppShell';
import { COPY } from '@/lib/copy';
import {
  __resetMemoryQueueForTest,
  clearQueuedRequests,
  enqueueRequest,
  flushQueue,
  queueSubscriberCount,
  subscribeQueue,
} from '@/pwa/offline-queue';

/**
 * 渲染 `AppShell`（内部 `BottomNav` 用 `NavLink`，必须包一层 Router）。
 *
 * 返回 `unmount` 供「卸载后不留订阅」用例使用。
 */
function renderShell(): { unmount: () => void } {
  return render(
    <MemoryRouter>
      <AppShell>
        <p>内容</p>
      </AppShell>
    </MemoryRouter>,
  );
}

/** 造一个成功响应包装（`{ data, error }`）。 */
function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

/** 造一个「HTTP 可达但业务失败」的响应（会走到丢弃路径）。 */
function badRequest(): { ok: false; status: number; json: () => Promise<unknown> } {
  return {
    ok: false,
    status: 400,
    json: async () => ({ data: null, error: { code: 'E_NOTFOUND_MEAL', message: 'nope' } }),
  };
}

beforeEach(async () => {
  __resetMemoryQueueForTest();
  await clearQueuedRequests();
  vi.unstubAllGlobals();
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  // `queueListeners` 是模块级集合：上一个用例残留的订阅会污染「订阅数」断言
  expect(queueSubscriberCount()).toBe(0);
});

describe('offline-queue 订阅机制（GAP-9）', () => {
  it('入队 / 冲队 / 移除都会通知订阅者，退订后不再通知', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeQueue(listener);

    await enqueueRequest({ path: '/weights', method: 'POST', body: { weightKg: 60 } });
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(1);

    const afterEnqueue = listener.mock.calls.length;
    unsubscribe();
    expect(queueSubscriberCount()).toBe(0);

    await enqueueRequest({ path: '/meals', method: 'POST', body: { a: 1 } });
    // 退订后不再有新的回调
    expect(listener.mock.calls.length).toBe(afterEnqueue);
  });

  it('冲队成功后会通知订阅者（UI 据此把条数刷新为 0）', async () => {
    await enqueueRequest({ path: '/weights', method: 'POST', body: { weightKg: 60 } });
    vi.stubGlobal('fetch', vi.fn(async () => ok({ id: 1 })));

    const listener = vi.fn();
    const unsubscribe = subscribeQueue(listener);

    const result = await flushQueue();
    expect(result.synced).toBe(1);
    expect(result.remaining).toBe(0);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(1);
    // 收尾退订：`queueListeners` 是模块级集合，测试之间会互相影响
    unsubscribe();
  });
});

describe('deriveSyncNotice（纯函数状态机）', () => {
  it('离线无排队 → offline；离线有排队 → offlinePending', () => {
    expect(deriveSyncNotice(false, 0, false)).toBe('offline');
    expect(deriveSyncNotice(false, 3, false)).toBe('offlinePending');
    // 离线下「有丢弃」不该覆盖更重要的「断网」状态
    expect(deriveSyncNotice(false, 3, true)).toBe('offlinePending');
  });

  it('联网有排队 → syncing；联网无排队且无丢弃 → none（横幅收起）', () => {
    expect(deriveSyncNotice(true, 2, false)).toBe('syncing');
    expect(deriveSyncNotice(true, 0, false)).toBe('none');
  });

  it('联网 + 有丢弃 → dropped（队列空时也保留说明）', () => {
    expect(deriveSyncNotice(true, 0, true)).toBe('dropped');
    expect(deriveSyncNotice(true, 2, true)).toBe('dropped');
  });
});

describe('AppShell 待同步横幅（GAP-9）', () => {
  it('离线且有排队 → 显示「还有 3 笔记录在本地排着队」', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    await enqueueRequest({ path: '/weights', method: 'POST', body: { weightKg: 60 } });
    await enqueueRequest({ path: '/meals', method: 'POST', body: { a: 1 } });
    await enqueueRequest({ path: '/wins', method: 'POST', body: { text: 'x' } });

    renderShell();

    expect(await screen.findByText(COPY.offlinePending(3))).toBeInTheDocument();
    expect(screen.getByTestId('offline-sync-banner')).toHaveAttribute(
      'data-sync-notice',
      'offlinePending',
    );
    // 主行仍是既有离线文案（回归保护）
    expect(screen.getByText(COPY.offlineNotice)).toBeInTheDocument();
  });

  it('离线且队列为空 → 只显示既有离线文案，不显示条数行', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });

    renderShell();

    expect(await screen.findByText(COPY.offlineNotice)).toBeInTheDocument();
    expect(screen.queryByTestId('offline-pending-line')).toBeNull();
  });

  it('联网 + 队列空 → 横幅整块不渲染', async () => {
    renderShell();

    await waitFor(() => expect(screen.queryByTestId('offline-sync-banner')).toBeNull());
  });

  it('联网但队列里还有货 → 显示「正在同步」，直到同步完收起', async () => {
    // 队列里有货，但 fetch 拒绝（保持队列不空），这样横幅应停在「正在同步」
    await enqueueRequest({ path: '/weights', method: 'POST', body: { weightKg: 60 } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('still offline');
      }),
    );

    renderShell();

    expect(await screen.findByText(COPY.offlineSyncing(1))).toBeInTheDocument();
    expect(screen.getByTestId('offline-sync-banner')).toHaveAttribute('data-sync-notice', 'syncing');
  });

  it('同步完成后条数归零 → 横幅收起（不写常驻「已同步」文案）', async () => {
    await enqueueRequest({ path: '/weights', method: 'POST', body: { weightKg: 60 } });
    vi.stubGlobal('fetch', vi.fn(async () => ok({ id: 1 })));

    renderShell();

    await waitFor(() => expect(screen.queryByTestId('offline-sync-banner')).toBeNull());
  });

  it('有记录被丢弃（dropped>0）→ 给一句软着陆说明，且**不含任何数字**、不含禁用词', async () => {
    // 一条毒消息：连续失败达上限后会被丢弃
    await enqueueRequest({ path: '/meals/reorder', method: 'PATCH', body: { bad: true } });
    vi.stubGlobal('fetch', vi.fn(async () => badRequest()));

    // 先在**未挂载**时冲 2 轮（只跳过、不丢弃），把失败计数推到 MAX-1
    await flushQueue();
    await flushQueue();

    // 再挂载：挂载后的那一次冲队就会达到上限并 `dropped` —— 这是 AppShell 能观察到的丢弃
    renderShell();

    const dropped = await screen.findByTestId('offline-dropped-line');
    expect(dropped).toHaveTextContent(COPY.offlineSyncDropped);

    const bannerText = screen.getByTestId('offline-sync-banner').textContent ?? '';
    // 硬约束：不出现被丢弃的条数
    expect(bannerText).not.toMatch(/\d/);
    // 硬约束：不出现任何失败 / 丢失 / 重试类词
    for (const banned of ['失败', '丢失', '未同步', '重试', '错误', '异常']) {
      expect(bannerText).not.toContain(banned);
    }
  });

  it('卸载后不留订阅（避免内存泄漏）', async () => {
    const { unmount } = renderShell();
    await waitFor(() => expect(queueSubscriberCount()).toBeGreaterThan(0));
    unmount();
    await waitFor(() => expect(queueSubscriberCount()).toBe(0));
  });

  it('入队后横幅实时更新（订阅生效，无需刷新）', async () => {
    renderShell();
    await waitFor(() => expect(screen.queryByTestId('offline-sync-banner')).toBeNull());

    // 模拟用户在别处离线记了一笔
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    await act(async () => {
      await enqueueRequest({ path: '/weights', method: 'POST', body: { weightKg: 60 } });
      window.dispatchEvent(new Event('offline'));
    });

    expect(await screen.findByText(COPY.offlinePending(1))).toBeInTheDocument();
  });
});
