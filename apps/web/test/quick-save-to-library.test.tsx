/**
 * C-4 第一步 · 快加卡「常吃的话勾上，下次直接选」（前端接线测试）。
 *
 * ## 背景
 *
 * 快加记下的食物此前**下次搜不到、每次都要重填**。本功能加一个勾选框：勾上后，
 * 记录成功**再**调 `POST /foods` 落一条自定义食物（服务端写死 `source=user_custom`）。
 *
 * ## 本文件钉死的行为
 *
 * ① **不勾选时不调 `POST /foods`**（默认不勾，不替用户制造噪音）；
 * ② **勾选时调 `POST /foods`**，且请求体字段正确（`name/category/kcalPer100g`），
 *    尤其 **`source` 不出现在请求体中**（服务端强制，前端不参与也参与不了）；
 * ③ **时序**：`POST /foods` 发生在记录（`onSubmit`）**成功之后** —— 记录在先；
 * ④ `POST /foods` 失败时：**记录仍算成功**（`onSubmit` 已 resolve），
 *    且提示是软着陆口径、**不含**违规字样（无「失败 / 错误 / 崩溃」，无红色类名）；
 * ⑤ 勾选后**成功**时给正向提示。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodItem, FoodSearchHit, FoodSearchResponse } from '@qsh/shared-types';
import MealComposer from '@/pages/diary/MealComposer';
import type { ComposerSubmit } from '@/pages/diary/MealComposer';

function makeHit(id: number, name: string, matchRank: 0 | 1 | 2 = 0, kcalPer100g = 100): FoodSearchHit {
  const food: FoodItem = {
    id,
    name,
    namePinyin: null,
    aliases: [],
    category: '家常菜',
    kcalPer100g,
    proteinGPer100g: 8,
    fatGPer100g: 6,
    carbGPer100g: 5,
    fiberGPer100g: null,
    sodiumMgPer100g: null,
    saturatedFatGPer100g: null,
    sugarGPer100g: null,
    calciumMgPer100g: null,
    ironMgPer100g: null,
    potassiumMgPer100g: null,
    vitaminDUgPer100g: null,
    b12UgPer100g: null,
    magnesiumMgPer100g: null,
    servingUnits: [{ unit: '克', grams: 100 }],
    defaultServingGrams: 100,
    barcode: null,
    source: 'cfcd',
    createdByUserId: null,
    isVerified: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  return { ...food, qualifier: null, matchRank };
}

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

/**
 * 记录 `POST /foods` 的请求体（若无则返回 null），并统计调用次数。
 *
 * `foodPost` 回调决定这次 `POST /foods` 是成功还是失败 —— 用于验证失败路径。
 */
interface Stub {
  fetchMock: ReturnType<typeof vi.fn>;
  foodPostCalls: () => Array<Record<string, unknown>>;
  orderCalls: () => string[];
}

function stubFetch(options: { foodPostOk?: boolean } = {}): Stub {
  const foodPostBodies: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/foods/search')) {
      const body: FoodSearchResponse = { items: [], total: 0, page: 1, pageSize: 10 };
      return ok(body);
    }
    if (url.includes('/foods/top')) return ok({ items: [], days: 30 });
    if (url.includes('/foods/recent') || url.includes('/foods/favorites')) return ok([]);
    if (url.includes('/meal-combos')) return ok([]);
    if (url.includes('/foods')) {
      if (method === 'POST') {
        order.push('foods-post');
        const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        foodPostBodies.push(parsed);
        if (options.foodPostOk === false) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ data: null, error: { code: 'E_SERVER', message: '服务端在开小差' } }),
          };
        }
        return ok({ id: 999, name: parsed.name });
      }
      return ok(null);
    }
    return ok(null);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    foodPostCalls: () => foodPostBodies,
    orderCalls: () => order,
  };
}

function renderComposer(onSubmit: (p: ComposerSubmit) => Promise<void>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MealComposer date="2026-09-27" mealType="lunch" onClose={vi.fn()} onSubmit={onSubmit} />
    </QueryClientProvider>,
  );
}

/** 切到「快加」tab 并填名称 + 热量。 */
async function fillQuick(name: string, kcal = '600') {
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: '快加' }));
  const nameInput = screen.getByPlaceholderText('如：楼下麻辣烫');
  await user.clear(nameInput);
  await user.type(nameInput, name);
  const kcalInput = screen.getByPlaceholderText('如：600');
  await user.clear(kcalInput);
  await user.type(kcalInput, kcal);
  return user;
}

/** 找到「存进食物库」勾选框（用可访问名定位，不依赖 testid）。 */
function saveCheckbox(): HTMLInputElement {
  return screen.getByRole('checkbox', { name: /常吃的话勾上/ }) as HTMLInputElement;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('C-4 快加 · 存进我的食物库', () => {
  it('默认不勾选：提交后**不**调 POST /foods', async () => {
    const stub = stubFetch();
    const onSubmit = vi.fn(async (_p: ComposerSubmit): Promise<void> => undefined);
    renderComposer(onSubmit);
    const user = await fillQuick('楼下麻辣烫', '600');

    expect(saveCheckbox().checked).toBe(false);

    await user.click(screen.getByRole('button', { name: '确认记录' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ kind: 'quick', name: '楼下麻辣烫', kcal: 600 });
    });

    // 给存库请求一点发生的机会，再断言它没发生
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.foodPostCalls()).toHaveLength(0);
  });

  it('勾选时调 POST /foods，请求体字段正确且不含 source', async () => {
    const stub = stubFetch();
    const onSubmit = vi.fn(async (_p: ComposerSubmit): Promise<void> => undefined);
    renderComposer(onSubmit);
    const user = await fillQuick('自制拿铁', '180');

    await user.click(saveCheckbox());
    expect(saveCheckbox().checked).toBe(true);

    await user.click(screen.getByRole('button', { name: '确认记录' }));

    await waitFor(() => {
      expect(stub.foodPostCalls()).toHaveLength(1);
    });
    const body = stub.foodPostCalls()[0] ?? {};
    expect(body.name).toBe('自制拿铁');
    expect(body.kcalPer100g).toBe(180);
    expect(body.category).toBe('other');
    // ★ 安全：契约里没有 source，前端**绝不**自己传（服务端强制 user_custom）
    expect('source' in body).toBe(false);
    expect('createdByUserId' in body).toBe(false);
  });

  it('时序：记录成功在前，存库在后（不产生孤儿条目）', async () => {
    const stub = stubFetch();
    const seq: string[] = [];
    const onSubmit = vi.fn(async (_p: ComposerSubmit): Promise<void> => {
      seq.push('record');
    });
    renderComposer(onSubmit);
    const user = await fillQuick('自制酸奶', '120');
    await user.click(saveCheckbox());
    await user.click(screen.getByRole('button', { name: '确认记录' }));

    await waitFor(() => expect(stub.foodPostCalls()).toHaveLength(1));
    // 记录先发生；存库（fetch 里 push 'foods-post'）在后
    expect(seq).toEqual(['record']);
    expect(stub.orderCalls()).toEqual(['foods-post']);
  });

  it('存库失败时：记录仍成功，提示软着陆且不含违规字样', async () => {
    stubFetch({ foodPostOk: false });
    const onSubmit = vi.fn(async (_p: ComposerSubmit): Promise<void> => undefined);
    renderComposer(onSubmit);
    const user = await fillQuick('楼下麻辣烫', '600');
    await user.click(saveCheckbox());
    await user.click(screen.getByRole('button', { name: '确认记录' }));

    // 记录照常成功
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ kind: 'quick', name: '楼下麻辣烫', kcal: 600 });
    });

    const note = await screen.findByRole('status');
    const text = note.textContent ?? '';
    // 软着陆：明确「记录已记下」，并给「待会儿再试」的去路
    expect(text).toContain('记录');
    expect(text).toContain('待会儿');
    // 无违规字样
    for (const banned of ['失败', '错误', '崩溃', '出错']) {
      expect(text).not.toContain(banned);
    }
    // 无红色恐吓类名
    expect(note.className).not.toMatch(/red|rose|danger/);
  });

  it('存库成功时给正向提示', async () => {
    stubFetch({ foodPostOk: true });
    const onSubmit = vi.fn(async (_p: ComposerSubmit): Promise<void> => undefined);
    renderComposer(onSubmit);
    const user = await fillQuick('自制拿铁', '180');
    await user.click(saveCheckbox());
    await user.click(screen.getByRole('button', { name: '确认记录' }));

    const note = await screen.findByRole('status');
    expect(note.textContent ?? '').toContain('食物库');
    expect(note.className).not.toMatch(/red|rose|danger/);
  });

  it('记录本身失败时不调 POST /foods（不留孤儿条目）', async () => {
    const stub = stubFetch();
    const onSubmit = vi.fn(async (_p: ComposerSubmit): Promise<void> => {
      throw new Error('记录失败');
    });
    renderComposer(onSubmit);
    const user = await fillQuick('楼下麻辣烫', '600');
    await user.click(saveCheckbox());
    await user.click(screen.getByRole('button', { name: '确认记录' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.foodPostCalls()).toHaveLength(0);
  });
});
