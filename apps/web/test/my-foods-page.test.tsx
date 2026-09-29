/**
 * C-4 第二步 · 我的食物库（前端接线测试）。
 *
 * ## 背景
 *
 * C-4 第一步让快加卡食物能**存进**库；本页补上「能管」——列出本人自建食物，可改、可删。
 *
 * ## 本文件钉死的行为
 *
 * ① 列表渲染 `GET /foods/mine` 的结果（名称 / 分类展示名 / 每 100g 热量）；
 * ② 编辑弹窗：改名字 → 调 `PATCH /foods/:id`，且**请求体不含 `source` / `createdByUserId`**
 *    （服务端强制，前端不参与也参与不了）；
 * ③ 删除：点「删掉」→ 调 `DELETE /foods/:id`，成功后列表更新（该条消失）；
 * ④ 空态文案存在且指向「怎么才会出现在这里」；
 * ⑤ 文案红线：新文案不含「失败 / 错误 / 崩溃」，无红色类名。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodItem } from '@qsh/shared-types';
import MyFoodsPage from '@/pages/foods/MyFoodsPage';
import { COPY } from '@/lib/copy';

function makeFood(id: number, name: string, category = '外卖', kcalPer100g = 620): FoodItem {
  return {
    id,
    name,
    namePinyin: null,
    aliases: [],
    category,
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
    source: 'user_custom',
    createdByUserId: 1,
    isVerified: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

interface Stub {
  calls: () => Call[];
  patchCalls: () => Call[];
  deleteCalls: () => Call[];
}

/** 桩：`/foods/mine` 返回可变列表；PATCH / DELETE 影响该列表（模拟服务端）。 */
function stubFetch(initial: FoodItem[]): Stub {
  const calls: Call[] = [];
  let current = initial;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });

    if (url.includes('/foods/mine')) {
      return ok(current);
    }
    if (method === 'PATCH' && /\/foods\/\d+$/.test(url)) {
      const id = Number(/\/foods\/(\d+)$/.exec(url)?.[1]);
      const index = current.findIndex((food) => food.id === id);
      const merged = { ...current[index], ...(body ?? {}) } as FoodItem;
      current = current.map((food) => (food.id === id ? merged : food));
      return ok(merged);
    }
    if (method === 'DELETE' && /\/foods\/\d+$/.test(url)) {
      const id = Number(/\/foods\/(\d+)$/.exec(url)?.[1]);
      current = current.filter((food) => food.id !== id);
      return ok({ deleted: true });
    }
    return ok(null);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls: () => calls,
    patchCalls: () => calls.filter((call) => call.method === 'PATCH'),
    deleteCalls: () => calls.filter((call) => call.method === 'DELETE'),
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MyFoodsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('C-4 我的食物库 · 列表', () => {
  it('渲染 GET /foods/mine 的结果（名称 / 分类展示名 / 每 100g 热量）', async () => {
    stubFetch([makeFood(11, '红烧肉', '家常菜', 680), makeFood(12, '楼下麻辣烫', '外卖', 620)]);
    renderPage();

    await waitFor(() => expect(screen.getByText('红烧肉')).toBeInTheDocument());
    expect(screen.getByText('楼下麻辣烫')).toBeInTheDocument();
    // 分类走 foodCategoryLabel（此处的值本就是展示名，other → 「其他」同理）
    expect(screen.getByText(/家常菜/)).toBeInTheDocument();
    // 每 100g 热量
    expect(screen.getByText(/每 100g 680 kcal/)).toBeInTheDocument();
  });

  it('空态：文案存在且说明「怎么才会出现在这里」', async () => {
    stubFetch([]);
    renderPage();

    const empty = await screen.findByTestId('my-foods-empty');
    expect(empty.textContent).toBe(COPY.myFoodsEmpty);
    // 指向「记录时快加并勾选」这条路径
    expect(empty.textContent).toContain('快加');
    expect(empty.textContent).toContain('常吃的话勾上');
  });
});

describe('C-4 我的食物库 · 编辑', () => {
  it('改名字 → 调 PATCH /foods/:id，请求体正确且不含 source / createdByUserId', async () => {
    const stub = stubFetch([makeFood(11, '红烧内', '家常菜', 620)]);
    renderPage();
    const user = userEvent.setup();

    await screen.findByText('红烧内');
    await user.click(screen.getByTestId('my-food-edit-11'));

    const dialog = await screen.findByTestId('edit-food-dialog');
    const nameInput = within(dialog).getByTestId('edit-food-name');
    await user.clear(nameInput);
    await user.type(nameInput, '红烧肉');
    await user.click(within(dialog).getByTestId('edit-food-save'));

    await waitFor(() => expect(stub.patchCalls()).toHaveLength(1));
    const patch = stub.patchCalls()[0];
    expect(patch?.url).toContain('/foods/11');
    expect(patch?.body?.name).toBe('红烧肉');
    expect(patch?.body?.category).toBe('家常菜');
    expect(typeof patch?.body?.kcalPer100g).toBe('number');
    // ★ 安全：前端**绝不**提交 source / createdByUserId
    expect('source' in (patch?.body ?? {})).toBe(false);
    expect('createdByUserId' in (patch?.body ?? {})).toBe(false);

    // 成功后弹窗关闭
    await waitFor(() => expect(screen.queryByTestId('edit-food-dialog')).not.toBeInTheDocument());
  });

  it('名称清空后提交：给中性提示且**不发请求**', async () => {
    const stub = stubFetch([makeFood(11, '红烧内', '家常菜', 620)]);
    renderPage();
    const user = userEvent.setup();

    await screen.findByText('红烧内');
    await user.click(screen.getByTestId('my-food-edit-11'));

    const dialog = await screen.findByTestId('edit-food-dialog');
    await user.clear(within(dialog).getByTestId('edit-food-name'));
    await user.click(within(dialog).getByTestId('edit-food-save'));

    const notice = await within(dialog).findByTestId('edit-food-notice');
    expect(notice.textContent).toBe(COPY.myFoodsEditNameRequired);
    expect(stub.patchCalls()).toHaveLength(0);
  });
});

describe('C-4 我的食物库 · 删除', () => {
  it('点「删掉」→ 调 DELETE /foods/:id，成功后列表更新（该条消失）', async () => {
    const stub = stubFetch([makeFood(11, '红烧内', '家常菜', 620), makeFood(12, '楼下麻辣烫', '外卖', 620)]);
    renderPage();
    const user = userEvent.setup();

    await screen.findByText('红烧内');
    await user.click(screen.getByTestId('my-food-delete-11'));

    await waitFor(() => expect(stub.deleteCalls()).toHaveLength(1));
    expect(stub.deleteCalls()[0]?.url).toContain('/foods/11');

    // 失效重取后，被删的那条消失、另一条仍在
    await waitFor(() => expect(screen.queryByText('红烧内')).not.toBeInTheDocument());
    expect(screen.getByText('楼下麻辣烫')).toBeInTheDocument();
  });

  it('删除按钮的读屏语句可访问名正确（myFoodDeleteAria）', async () => {
    stubFetch([makeFood(11, '红烧内', '家常菜', 620)]);
    renderPage();

    const button = await screen.findByTestId('my-food-delete-11');
    expect(button).toHaveAccessibleName('删掉这个食物：红烧内');
  });
});

describe('C-4 我的食物库 · 文案红线（PRD §7 无负罪感）', () => {
  it('新增文案不含「失败 / 错误 / 崩溃」，且无红色类名', async () => {
    const newCopyTexts = [
      COPY.myFoodsTitle,
      COPY.myFoodsDesc,
      COPY.myFoodsEmpty,
      COPY.myFoodsLoadError,
      COPY.myFoodsLoading,
      COPY.myFoodsEdit,
      COPY.myFoodsDelete,
      COPY.myFoodsDeleted,
      COPY.myFoodsDeleteMissed,
      COPY.myFoodsEditTitle,
      COPY.myFoodsEditDesc,
      COPY.myFoodsEditNameLabel,
      COPY.myFoodsEditCategoryLabel,
      COPY.myFoodsEditKcalLabel,
      COPY.myFoodsEditSave,
      COPY.myFoodsEditCancel,
      COPY.myFoodsEditBusy,
      COPY.myFoodsEditNameRequired,
      COPY.myFoodsEditKcalRequired,
      COPY.myFoodsEditMissed,
      COPY.myFoodsEdited,
    ];
    for (const text of newCopyTexts) {
      for (const banned of ['失败', '错误', '崩溃', '出错']) {
        expect(text).not.toContain(banned);
      }
    }

    stubFetch([makeFood(11, '红烧内', '家常菜', 620)]);
    renderPage();
    await screen.findByText('红烧内');

    // 整页无红色恐吓类名
    const root = document.body;
    expect(root.innerHTML).not.toMatch(/text-red|bg-red|border-red|ring-red/);
  });
});
