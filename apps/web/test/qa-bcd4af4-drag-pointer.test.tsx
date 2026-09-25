/**
 * QA 独立证伪（software-qa-engineer-4）—— bcd4af4 的 **P0-1 拖拽落位**。
 *
 * 上一轮 QA 的盲区：`meal-reorder.test.tsx` 只走 `fireEvent.click`（降级按钮），
 * pointer 拖拽路径**零覆盖**，于是「餐内拖拽落位恒为 0」这种功能级缺陷被放行。
 *
 * 本文件**不依赖工程师写的断言**，自己从 pointer 事件层向下钉死落位下标：
 * - 用 4 条午餐记录，把第 4 条拖到「第 2 条与第 3 条之间」→ 目标下标 **2（第 3 位）**；
 * - 缺陷存在时（`middles` 恒空 → `index` 恒 0）会退化成 `[4,1,2,3]`（跑到第 1 位），断言必失败。
 *
 * 复现红色的方法（见交付报告）：把 `snapshot()` 里 `middles` 强制为 `[]`，本文件立即变红。
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

/** 午餐四条：A(1) / B(2) / C(3) / D(4)。 */
function mealsResponse(): ListMealsResponse {
  return {
    date: TODAY,
    groups: [
      { mealType: 'breakfast', logs: [], totalKcal: 0 },
      {
        mealType: 'lunch',
        logs: [makeLog(1, 'QA-A', 0), makeLog(2, 'QA-B', 1), makeLog(3, 'QA-C', 2), makeLog(4, 'QA-D', 3)],
        totalKcal: 800,
      },
      { mealType: 'dinner', logs: [], totalKcal: 0 },
      { mealType: 'snack', logs: [], totalKcal: 0 },
    ],
    totalKcal: 800,
  };
}

interface CapturedRequest {
  url: string;
  method: string;
  body: { mealType?: string; orderedIds?: number[]; loggedDate?: string } | undefined;
}

let captured: CapturedRequest[] = [];

/** 取第一条捕获到的 reorder 请求（`noUncheckedIndexedAccess` 下收口 undefined）。 */
function firstCaptured(): CapturedRequest {
  const request = captured[0];
  if (request === undefined) {
    throw new Error('没有捕获到 reorder 请求');
  }
  return request;
}

function stubFetch(): void {
  captured = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/meals/reorder')) {
        captured.push({
          url,
          method,
          body: init?.body === undefined ? undefined : JSON.parse(init.body),
        });
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
 * 午餐落区 y∈[0,400]；四条中点分别 50 / 150 / 250 / 350。
 * 于是命中区间：<50→0，50..150→1，150..250→2，250..350→3，>350→4（末尾）。
 */
function stubLunchGeometry(): void {
  const zone = document.querySelector('[data-meal-type="lunch"]');
  if (zone === null) throw new Error('没找到午餐落区');
  stubRect(zone, 0, 400);
  stubRect(screen.getByTestId('meal-item-1'), 0, 100);
  stubRect(screen.getByTestId('meal-item-2'), 100, 100);
  stubRect(screen.getByTestId('meal-item-3'), 200, 100);
  stubRect(screen.getByTestId('meal-item-4'), 300, 100);
  // 空的加餐落区 y∈[500,600]（用于跨餐拖拽）
  const snack = document.querySelector('[data-meal-type="snack"]');
  if (snack !== null) stubRect(snack, 500, 100);
}

async function waitForRows(): Promise<void> {
  await waitFor(() => expect(screen.getByText('QA-D')).toBeInTheDocument());
}

function pointerDown(id: number, y: number): void {
  const handle = screen.getByTestId(`meal-drag-handle-${id}`);
  fireEvent(
    handle,
    new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: 200,
      clientY: y,
    }),
  );
}

async function passLongPress(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_WAIT_MS));
  });
}

async function moveAndDrop(targetY: number): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 200, clientY: targetY }),
    );
    window.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 200, clientY: targetY }),
    );
  });
}

async function dragTo(id: number, startY: number, targetY: number): Promise<void> {
  pointerDown(id, startY);
  await passLongPress();
  await moveAndDrop(targetY);
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

describe('QA 证伪 · bcd4af4 P0-1 餐内拖拽落位（pointer 路径）', () => {
  it('把第 1 条拖到「第 2/3 条之间」→ 落位下标 2；该条位于第 3 位（不是 0）', async () => {
    // 第 1 条(A) 拖到 150..250 之间(y=200) → index=2 → [B,C,A,D] = [2,3,1,4]
    renderPage();
    await waitForRows();
    stubLunchGeometry();

    await dragTo(1, 20, 200);
    await waitFor(() => expect(captured).toHaveLength(1));

    const body = firstCaptured().body;
    expect(firstCaptured().method).toBe('PATCH');
    expect(firstCaptured().url).toContain('/api/meals/reorder');
    expect(body?.loggedDate).toBe(TODAY);
    expect(body?.mealType).toBe('lunch');
    expect(body?.orderedIds).toEqual([2, 3, 1, 4]);
    // 显式钉死「位于第 3 位」
    expect(body?.orderedIds?.[2]).toBe(1);
  });

  it('把第 4 条拖到「第 2/3 条之间」→ 落位下标 2；该条位于第 3 位（不是 0）', async () => {
    // 第 4 条(D) 拖到 150..250 之间(y=200) → index=2 → [A,B,D,C] = [1,2,4,3]
    renderPage();
    await waitForRows();
    stubLunchGeometry();

    await dragTo(4, 320, 200);
    await waitFor(() => expect(captured).toHaveLength(1));

    expect(firstCaptured().body?.orderedIds).toEqual([1, 2, 4, 3]);
    expect(firstCaptured().body?.orderedIds?.[2]).toBe(4);
  });

  it('把第 3 条拖到「第 1/2 条之间」→ 落位下标 1（中间插入，不是 0）', async () => {
    // 第 3 条(C) 拖到 50..150 之间(y=100) → index=1 → [A,C,B,D] = [1,3,2,4]
    renderPage();
    await waitForRows();
    stubLunchGeometry();

    await dragTo(3, 220, 100);
    await waitFor(() => expect(captured).toHaveLength(1));

    expect(firstCaptured().body?.orderedIds).toEqual([1, 3, 2, 4]);
  });

  it('拖到本餐最后一条之下 → index = 条目数（追加到末尾，不是 0）', async () => {
    // 第 1 条(A) 拖到 >350(y=380) → index=4 → [B,C,D,A] = [2,3,4,1]
    renderPage();
    await waitForRows();
    stubLunchGeometry();

    await dragTo(1, 20, 380);
    await waitFor(() => expect(captured).toHaveLength(1));

    expect(firstCaptured().body?.orderedIds).toEqual([2, 3, 4, 1]);
    expect(firstCaptured().body?.orderedIds?.[3]).toBe(1);
  });

  it('在途守卫：第二根手指 / 重复 pointerdown 不会劫持进行中的手势', async () => {
    renderPage();
    await waitForRows();
    stubLunchGeometry();

    // 先按下 A(1)，再（未松手时）按下 D(4) —— 守卫应忽略第二次
    pointerDown(1, 20);
    pointerDown(4, 320);
    await passLongPress();
    await moveAndDrop(200);

    await waitFor(() => expect(captured).toHaveLength(1));
    // 手势应归属**第一次**按下的 A(1)：index=2 → [2,3,1,4]
    // 若守卫失效，第二次 pointerdown 会覆盖 startRef → 拖动的是 D(4) → [1,2,4,3]
    expect(firstCaptured().body?.orderedIds).toEqual([2, 3, 1, 4]);
  });

  it('长按计时器未触发就松手 → 不提交任何 reorder', async () => {
    renderPage();
    await waitForRows();
    stubLunchGeometry();

    pointerDown(1, 20);
    // 不等待长按，直接松手
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 200, clientY: 20 }));
    });
    expect(captured).toHaveLength(0);

    // 等过阈值确认也不会迟到的提交
    await passLongPress();
    expect(captured).toHaveLength(0);
  });

  it('跨餐拖拽：把午餐条目拖到加餐落区 → mealType=snack 且该条进入目标餐', async () => {
    renderPage();
    await waitForRows();
    stubLunchGeometry();

    // y=550 落在加餐落区 y∈[500,600]；该落区当前为空 → 目标下标 0、追加为目标餐唯一项
    await dragTo(2, 120, 550);
    await waitFor(() => expect(captured).toHaveLength(1));
    expect(firstCaptured().body?.mealType).toBe('snack');
    expect(firstCaptured().body?.orderedIds).toEqual([2]);
  });
});