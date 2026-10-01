/**
 * C-3「一餐多品项批量记录」接线测试（多选模式 + 待记清单）。
 *
 * 钉死六件事：
 * ① **核心**：多选模式下点搜索结果 → 进入**待记清单**而**不是立即入库**（没有 `POST /meals`）；
 * ② **一次确认 → 全部写入**：`onSubmit` 恰好被调用 **1 次**、载荷是 `kind:'batch'` 且含全部条目
 *    （不是 N 次单条请求）；
 * ③ **可逐项移除 / 可整体放弃**：放弃后清单消失且**不发出任何写入请求**；
 * ④ 🔴 **红线**：多选清单里**不出现合计热量 / 超标提示**（文本无「合计 / 超标 / 超出」、
 *    且无红色类名）；
 * ⑤ **不破坏原路径**：不开多选时，点食物仍是「份量确认 → 单条记录」，行为完全不变；
 * ⑥ 多选阶段**不弹份量确认区**（`选择份量` 不出现）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodItem, FoodSearchHit, FoodSearchResponse } from '@qsh/shared-types';
import MealComposer from '@/pages/diary/MealComposer';
import type { ComposerSubmit } from '@/pages/diary/MealComposer';

/** 造一条搜索结果（字段与契约一致：FoodItem + qualifier + matchRank）。 */
function makeHit(
  id: number,
  name: string,
  qualifier: string | null,
  matchRank: 0 | 1 | 2,
  kcalPer100g = 100,
): FoodSearchHit {
  const food: FoodItem = {
    id,
    name,
    namePinyin: null,
    aliases: [],
    category: '蔬菜',
    kcalPer100g,
    proteinGPer100g: 2,
    fatGPer100g: 1,
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
  return { ...food, qualifier, matchRank };
}

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

let fetchCalls: string[] = [];

/** stub `fetch`：搜索返回固定三条，其余只读接口返回空。 */
function stubFetch(hits: FoodSearchHit[]): void {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.includes('/foods/search')) {
      const body: FoodSearchResponse = { items: hits, total: hits.length, page: 1, pageSize: 20 };
      return ok(body);
    }
    if (url.includes('/foods/last-portions')) {
      return ok({ portions: {} });
    }
    if (url.includes('/foods/top')) {
      return ok({ days: 90, items: [] });
    }
    if (url.includes('/foods/live-search')) {
      return ok({ items: [], found: 0, skipped: 0, degraded: false, source: 'openfoodfacts', license: 'ODbL 1.0' });
    }
    if (url.includes('/foods/favorites')) {
      return ok([]);
    }
    return ok([]);
  });
  vi.stubGlobal('fetch', mock);
}

/** 渲染并把 `onSubmit` mock 交回（断言调用次数 / 载荷）。 */
function renderComposer(): ReturnType<typeof vi.fn> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSubmit = vi.fn(async (_payload: ComposerSubmit) => undefined);
  render(
    <QueryClientProvider client={client}>
      <MealComposer date="2026-09-12" mealType="lunch" onClose={vi.fn()} onSubmit={onSubmit} />
    </QueryClientProvider>,
  );
  return onSubmit;
}

/** 打开搜索并返回搜索结果里的食物行（排除「待记清单」区域内的行）。 */
async function searchRows(): Promise<HTMLElement[]> {
  fireEvent.change(screen.getByLabelText('搜索食物'), { target: { value: '柠青实验' } });
  await waitFor(() => {
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
  });
  const pending = screen.queryByRole('region', { name: '待记清单' });
  const rows = screen.getAllByRole('listitem');
  return pending === null ? rows : rows.filter((row) => !pending.contains(row));
}

/** 点某搜索结果行里的「选食物」按钮（行内第一个按钮；星号是第二个）。 */
function clickFood(row: HTMLElement): void {
  const buttons = within(row).getAllByRole('button');
  const first = buttons[0];
  if (first === undefined) throw new Error('搜索结果行里没有可点的按钮');
  fireEvent.click(first);
}

/** 打开 / 关闭多选模式。 */
function toggleMultiSelect(): void {
  fireEvent.click(screen.getByLabelText('多选记录'));
}

/** 待记清单区域（未渲染时返回 null）。 */
function pendingPanel(): HTMLElement | null {
  return screen.queryByRole('region', { name: '待记清单' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchCalls = [];
});

describe('C-3 多选模式：点食物进清单、不立即入库', () => {
  it('默认关闭多选；打开后点搜索结果 → 进待记清单（无 POST /meals、无份量确认区）', async () => {
    stubFetch([makeHit(1, '宽粉', null, 0, 150)]);
    const onSubmit = renderComposer();

    // 默认关闭
    expect(screen.getByLabelText('多选记录')).not.toBeChecked();

    const rows = await searchRows();
    toggleMultiSelect();
    expect(screen.getByLabelText('多选记录')).toBeChecked();

    clickFood(rows[0] as HTMLElement);

    // ★ 进入待记清单
    const panel = await waitFor(() => {
      const found = pendingPanel();
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(panel).getByText('宽粉')).toBeInTheDocument();

    // ★ 没有立即入库：onSubmit 未被调用，且没有发过任何 /meals 请求
    expect(onSubmit).not.toHaveBeenCalled();
    expect(fetchCalls.some((url) => url.includes('/meals'))).toBe(false);

    // ★ 多选阶段不弹份量确认区
    expect(screen.queryByRole('region', { name: '选择份量' })).not.toBeInTheDocument();
  });

  it('重复点同一样 → 仍只有 1 条（去重）', async () => {
    stubFetch([makeHit(1, '宽粉', null, 0, 150)]);
    renderComposer();
    const rows = await searchRows();
    toggleMultiSelect();

    clickFood(rows[0] as HTMLElement);
    clickFood(rows[0] as HTMLElement);

    const panel = await waitFor(() => pendingPanel() as HTMLElement);
    expect(within(panel).getAllByRole('listitem')).toHaveLength(1);
    expect(within(panel).getByText('待记清单（1 样）')).toBeInTheDocument();
  });
});

describe('C-3 一次确认 → 全部写入（单次请求）', () => {
  it('加入 3 样 → 点「记录这 3 样」→ onSubmit 恰好 1 次、载荷含全部条目', async () => {
    stubFetch([
      makeHit(1, '宽粉', null, 0, 150),
      makeHit(2, '豆腐皮', null, 0, 200),
      makeHit(3, '青菜', null, 0, 30),
    ]);
    const onSubmit = renderComposer();
    const rows = await searchRows();
    toggleMultiSelect();

    clickFood(rows[0] as HTMLElement);
    clickFood(rows[1] as HTMLElement);
    clickFood(rows[2] as HTMLElement);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '记录这 3 样' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '记录这 3 样' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    // ★ 不是 N 次单条请求 —— 只有 1 次，且是 batch
    const payload = onSubmit.mock.calls[0]?.[0] as ComposerSubmit;
    expect(payload.kind).toBe('batch');
    if (payload.kind === 'batch') {
      expect(payload.items).toHaveLength(3);
      expect(payload.items.map((item) => item.foodId)).toEqual([1, 2, 3]);
      expect(payload.items.map((item) => item.grams)).toEqual([100, 100, 100]);
      expect(payload.items.map((item) => item.servingUnit)).toEqual(['克', '克', '克']);
    }
    // 依然没有直接打 /meals（入库交给父组件的批量端点）
    expect(fetchCalls.some((url) => url.includes('/meals'))).toBe(false);
  });

  it('逐项移除：清单条数随之减少', async () => {
    stubFetch([makeHit(1, '宽粉', null, 0, 150), makeHit(2, '豆腐皮', null, 0, 200)]);
    renderComposer();
    const rows = await searchRows();
    toggleMultiSelect();
    clickFood(rows[0] as HTMLElement);
    clickFood(rows[1] as HTMLElement);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '记录这 2 样' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '移除 宽粉' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '记录这 1 样' })).toBeInTheDocument();
    });
    // 只断言「清单里」不再有宽粉（搜索结果行里当然还有「宽粉」那条食物）
    const panel = pendingPanel() as HTMLElement;
    expect(within(panel).queryByText('宽粉')).not.toBeInTheDocument();
    expect(within(panel).getByText('待记清单（1 样）')).toBeInTheDocument();
  });

  it('整体放弃 → 清单清空、且不发出任何写入请求', async () => {
    stubFetch([makeHit(1, '宽粉', null, 0, 150), makeHit(2, '豆腐皮', null, 0, 200)]);
    const onSubmit = renderComposer();
    const rows = await searchRows();
    toggleMultiSelect();
    clickFood(rows[0] as HTMLElement);
    clickFood(rows[1] as HTMLElement);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '记录这 2 样' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '整体放弃' }));

    await waitFor(() => {
      expect(pendingPanel()).toBeNull();
    });
    // 清单为空 → 确认区退化为中性引导，且没有任何写入
    expect(screen.getByText('点上面的食物，加进待记清单')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(fetchCalls.some((url) => url.includes('/meals'))).toBe(false);
  });
});

describe('C-3 红线：多选清单不出现合计热量 / 超标提示', () => {
  it('清单文本不含「合计 / 超标 / 超出 / 超量 / 预算」，且无红色类名', async () => {
    stubFetch([makeHit(1, '宽粉', null, 0, 500), makeHit(2, '油炸丸子', null, 0, 600)]);
    renderComposer();
    const rows = await searchRows();
    toggleMultiSelect();
    clickFood(rows[0] as HTMLElement);
    clickFood(rows[1] as HTMLElement);

    const panel = await waitFor(() => pendingPanel() as HTMLElement);
    const text = panel.textContent ?? '';
    for (const banned of ['合计', '超标', '超出', '超量', '预算', '热量']) {
      expect(text).not.toContain(banned);
    }
    // 无红色 / 玫红类名（不制造负罪感的视觉语言）
    expect(panel.outerHTML).not.toMatch(/(red|rose)-/);
  });
});

describe('C-3 不破坏原路径：不开多选时行为完全不变', () => {
  it('点食物 → 份量确认区出现（不入库）→ 点「确认记录」→ 单条记录', async () => {
    stubFetch([makeHit(1, '宽粉', null, 0, 150)]);
    const onSubmit = renderComposer();
    const rows = await searchRows();

    clickFood(rows[0] as HTMLElement);

    // 份量确认区照常出现；未立即入库
    expect(screen.getByRole('region', { name: '选择份量' })).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认记录' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    const payload = onSubmit.mock.calls[0]?.[0] as ComposerSubmit;
    expect(payload.kind).toBe('food');
    if (payload.kind === 'food') {
      expect(payload.food.id).toBe(1);
      expect(payload.grams).toBe(100);
    }
  });
});
