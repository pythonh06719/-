/**
 * 餐内拖拽的 **pointer 路径**测试（R3.8 / AC-3.8.6）—— 补上 `meal-reorder.test.tsx`
 * 完全没覆盖的一条路径（那个文件只用 `fireEvent.click` 走降级控件）。
 *
 * ## 这条测试要钉死的真实缺陷
 *
 * 旧实现把「向上找 `data-meal-type` 祖先」写在 item 的 ref 回调里，并要求该餐次**已经**
 * 在 `zonesRef` 注册 —— 但 React 的 ref 回调是**子先父后**（`<li>` 早于 `<section>`），
 * 于是所有 item 都被静默丢弃 → `middles` 恒为空 → 命中下标恒为 `0` →
 * **拖到第 N 位松手后一律跑到第 1 位**。
 *
 * 因此这里断言的是**中间位置**的落位结果（`orderedIds` 含正确下标），而不是「有提交就算过」：
 * - 把第 1 条拖到第 2/3 条之间（下标 1）→ `[2,1,3]` 一类的**中间插入**；
 * - 把第 3 条拖到第 1/2 条之间（下标 1）→ `[1,3,2]`。
 *
 * 缺陷存在时两条都会退化成「插到最前」（`[3,1,2]`），断言必失败。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ListMealsResponse, MealLog, MealType } from '@qsh/shared-types';
import DiaryPage from '@/pages/diary/DiaryPage';
import { todayKey } from '@/lib/format';
import { cacheClearAll } from '@/lib/local-cache';
import { __resetMemoryQueueForTest } from '@/pwa/offline-queue';

const TODAY = todayKey();

/** 长按阈值（`DEFAULT_LONG_PRESS_MS`）+ 余量。 */
const LONG_PRESS_WAIT_MS = 360;

function makeLog(id: number, name: string, sortOrder: number, mealType: MealType = 'lunch'): MealLog {
  return {
    id,
    userId: 1,
    loggedDate: TODAY,
    mealType,
    foodItemId: null,
    customName: name,
    grams: 100,
    servingUnit: '克',
    servingQty: 1,
    kcal: 200,
    proteinG: null,
    fatG: null,
    carbG: null,
    fiberG: null,
    sodiumMg: null,
    source: 'quick_add',
    comboId: null,
    note: null,
    sortOrder,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  };
}

/** 午餐三条：番茄炒蛋(1) / 米饭(2) / 青菜(3)。 */
function mealsResponse(): ListMealsResponse {
  return {
    date: TODAY,
    groups: [
      { mealType: 'breakfast', logs: [], totalKcal: 0 },
      {
        mealType: 'lunch',
        logs: [makeLog(1, '番茄炒蛋', 0), makeLog(2, '米饭', 1), makeLog(3, '青菜', 2)],
        totalKcal: 600,
      },
      { mealType: 'dinner', logs: [], totalKcal: 0 },
      { mealType: 'snack', logs: [], totalKcal: 0 },
    ],
    totalKcal: 600,
  };
}

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

let captured: CapturedRequest[] = [];

function stubFetch(): void {
  captured = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/meals/reorder')) {
        captured.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({ data: { updated: [] }, error: null }) };
      }
      if (url.includes('/weights')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { points: [], movingAverage7: [], stats: {}, forecast: [], goalProgress: null },
            error: null,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: mealsResponse(), error: null }) };
    }),
  );
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DiaryPage initialDate={TODAY} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 给元素打一个固定的几何矩形（jsdom 默认全是 0，命中检测会全部落空）。 */
function stubRect(element: Element, top: number, height: number, left = 0, width = 400): void {
  element.getBoundingClientRect = (): DOMRect =>
    ({
      top,
      bottom: top + height,
      height,
      left,
      right: left + width,
      width,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/**
 * 为「午餐」落区与三条记录打几何：
 * 落区 y∈[0,300]，三条中点分别在 50 / 150 / 250。
 */
function stubLunchGeometry(): void {
  const zone = document.querySelector('[data-meal-type="lunch"]');
  if (zone === null) {
    throw new Error('没找到午餐落区');
  }
  stubRect(zone, 0, 300);
  stubRect(screen.getByTestId('meal-item-1'), 0, 100);
  stubRect(screen.getByTestId('meal-item-2'), 100, 100);
  stubRect(screen.getByTestId('meal-item-3'), 200, 100);
}

/** 等午餐三条渲染出来。 */
async function waitForRows(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText('番茄炒蛋')).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByText('青菜')).toBeInTheDocument();
  });
}

/**
 * 走一次完整的 pointer 拖拽：按下手柄 → 等长按 → 移动到目标点 → 松手。
 *
 * 用 `MouseEvent` 派发 pointer 事件：jsdom 对 `PointerEvent` 支持不一，
 * 而本 hook 只读 `clientX / clientY / button`，用 MouseEvent 承载这三者是等价且稳定的。
 */
async function dragTo(id: number, startY: number, targetY: number): Promise<void> {
  const handle = screen.getByTestId(`meal-drag-handle-${id}`);
  fireEvent(
    handle,
    new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: 200,
      clientY: startY,
    }),
  );

  // 进入拖拽态（长按计时器触发）—— 状态更新来自定时器，需要 act 包裹
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_WAIT_MS));
  });

  await act(async () => {
    window.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 200, clientY: targetY }),
    );
    window.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 200, clientY: targetY }),
    );
  });
}

beforeEach(() => {
  cacheClearAll();
  __resetMemoryQueueForTest();
  window.localStorage.clear();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('R3.8 pointer 拖拽落位（AC-3.8.6 / 中间位置必须正确）', () => {
  it('手柄存在且拖拽态可进入（长按 ≥300ms 才生效）', async () => {
    renderPage();
    await waitForRows();
    stubLunchGeometry();

    const handle = screen.getByTestId('meal-drag-handle-1');
    fireEvent(
      handle,
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 200, clientY: 20 }),
    );

    // 长按计时器未触发前：不应有任何提交
    expect(captured).toHaveLength(0);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_WAIT_MS));
    });
    expect(captured).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    });
  });

  it('把第 3 条拖到第 1/2 条之间 → 落位下标 1（不是 0）', async () => {
    renderPage();
    await waitForRows();
    stubLunchGeometry();

    // y=120：介于中点 50 与 150 之间 → 目标下标 1
    await dragTo(3, 220, 120);

    await waitFor(() => {
      expect(captured).toHaveLength(1);
    });
    const request = captured[0] as CapturedRequest;
    expect(request.method).toBe('PATCH');
    expect(request.url).toContain('/api/meals/reorder');
    // 青菜(3) 插到 米饭(2) 之前：完整期望顺序 = [1, 3, 2]
    // 缺陷存在时会退化成 [3, 1, 2]（插到最前）
    expect(request.body).toMatchObject({ loggedDate: TODAY, mealType: 'lunch', orderedIds: [1, 3, 2] });
  });

  it('把第 1 条拖到第 2/3 条之间 → 落位下标 2（不是 0）', async () => {
    renderPage();
    await waitForRows();
    stubLunchGeometry();

    // y=170：介于中点 150 与 250 之间 → 目标下标 2
    await dragTo(1, 20, 170);

    await waitFor(() => {
      expect(captured).toHaveLength(1);
    });
    // 番茄炒蛋(1) 插到末尾：完整期望顺序 = [2, 3, 1]
    // 缺陷存在时会退化成 [1, 2, 3]（原地不动 / 插到最前）
    expect((captured[0] as CapturedRequest).body).toMatchObject({
      mealType: 'lunch',
      orderedIds: [2, 3, 1],
    });
  });

  it('拖到本餐最后一条之下 → 追加到末尾（下标 = 条目数）', async () => {
    renderPage();
    await waitForRows();
    stubLunchGeometry();

    // y=290：大于最大中点 250 → 下标 3（末尾）
    await dragTo(2, 120, 290);

    await waitFor(() => {
      expect(captured).toHaveLength(1);
    });
    expect((captured[0] as CapturedRequest).body).toMatchObject({
      mealType: 'lunch',
      orderedIds: [1, 3, 2],
    });
  });

  it('拖拽全程不改动任何热量数字（AC-3.8.2）', async () => {
    renderPage();
    await waitForRows();
    stubLunchGeometry();

    expect(screen.getByText('600')).toBeInTheDocument();
    await dragTo(3, 220, 120);
    await waitFor(() => {
      expect(captured).toHaveLength(1);
    });
    expect(screen.getByText('600')).toBeInTheDocument();
  });
});
