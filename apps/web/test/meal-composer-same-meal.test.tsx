/**
 * 「重复记录温和提示」接线测试（pages/diary/MealComposer.tsx / D-2）。
 *
 * 背景：用户记了一餐、过了一会儿忘了又记一次同样的东西 → 当天热量**虚高**，
 * 而他完全不知道（G2「数字可信」的隐蔽杀手）。
 *
 * 但**这可能真的不是重复**（用户可能就是又吃了一碗饭），所以本功能的**第一原则是默认放行**。
 * 本用例钉死它的边界：
 *
 * ① ★ **核心**：同一天 + 同一餐已记过同一食物 → 出现一句温和觉察；
 * ② ★★ **更核心：默认放行** —— 提示出现后**照常能记录成功**（`onSubmit` 正常发生，不被拦截）；
 * ③ **不误报**：不同餐次 / 不同日期 / 不同食物 → 不提示（那是正常的）；
 * ④ **文案红线**：提示文本不含「重复 / 记错了 / 请注意 / 确定要」这类指责式说法，
 *    且提示元素**无红色类名**；
 * ⑤ 快加 / 多选两条路径同源命中（同一句觉察）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodItem, ServingUnit } from '@qsh/shared-types';
import type { MealItemIdentity } from '@qsh/core';
import MealComposer from '@/pages/diary/MealComposer';
import { COPY } from '@/lib/copy';

const TODAY = '2026-09-12';

/** 造一个食物库条目（字段与 `FoodItem` 契约一致）。 */
function makeFood(id: number, name: string, servingUnits: ServingUnit[]): FoodItem {
  return {
    id,
    name,
    namePinyin: null,
    aliases: [],
    category: '主食',
    kcalPer100g: 116,
    proteinGPer100g: 2.6,
    fatGPer100g: 0.3,
    carbGPer100g: 25.9,
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
    servingUnits,
    defaultServingGrams: 200,
    barcode: null,
    source: 'builtin',
    createdByUserId: null,
    isVerified: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

/** 一条已有记录的最小投影（D-2 的面板入参）。 */
function existingRow(overrides: Partial<MealItemIdentity> = {}): MealItemIdentity {
  return {
    loggedDate: TODAY,
    mealType: 'lunch',
    foodItemId: null,
    customName: null,
    ...overrides,
  };
}

/** 「最近」tab 的食物列表（`GET /foods/recent`）。 */
let recentItems: FoodItem[] = [];

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input);
      if (url.includes('/foods/last-portions')) {
        return ok({ portions: {} });
      }
      if (url.includes('/foods/recent')) {
        return ok(recentItems);
      }
      if (url.includes('/foods/favorites')) {
        return ok([]);
      }
      if (url.includes('/foods/top')) {
        return ok({ days: 90, items: [] });
      }
      if (url.includes('/foods/search')) {
        return ok({ items: [], total: 0, page: 1, pageSize: 10 });
      }
      return ok([]);
    }),
  );
}

interface RenderOptions {
  onSubmit?: () => Promise<void>;
  existingMealItems?: MealItemIdentity[];
  mealType?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
}

function renderComposer(options: RenderOptions = {}): () => Promise<void> {
  const onSubmit = options.onSubmit ?? vi.fn(async () => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MealComposer
        date={TODAY}
        mealType={options.mealType ?? 'lunch'}
        existingMealItems={options.existingMealItems}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />
    </QueryClientProvider>,
  );
  return onSubmit;
}

async function openTab(name: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('tab', { name })).toBeInTheDocument();
  });
  fireEvent.click(screen.getByRole('tab', { name }));
}

function gramsInput(): HTMLInputElement {
  return screen.getByLabelText('克数') as HTMLInputElement;
}

/** 选中「最近」tab 里的一条食物，等份量确认区就绪。 */
async function selectFoodFromRecent(name: string): Promise<void> {
  await openTab('最近');
  const row = await screen.findByText(name);
  await waitFor(() => {
    fireEvent.click(row.closest('button') as HTMLElement);
    expect(gramsInput().value).not.toBe('');
  });
}

beforeEach(() => {
  recentItems = [makeFood(7, '米饭', [{ unit: '份', grams: 200, label: '一份' }])];
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('D-2 重复记录温和提示', () => {
  it('★ 同日同餐已记过同一食物 → 出现一句温和觉察', async () => {
    renderComposer({ existingMealItems: [existingRow({ foodItemId: 7 })] });
    await selectFoodFromRecent('米饭');

    const hint = await screen.findByTestId('same-meal-hint');
    expect(hint.textContent).toBe(COPY.sameMealHint);
  });

  it('★★ 默认放行：提示出现后，照常能记录成功（不被拦截）', async () => {
    const onSubmit = renderComposer({ existingMealItems: [existingRow({ foodItemId: 7 })] });
    await selectFoodFromRecent('米饭');

    // 提示确实出现了……
    expect(await screen.findByTestId('same-meal-hint')).toBeInTheDocument();

    // ……但它**不挡路**：点「确认记录」→ onSubmit 被正常调用（写入没有被阻断）
    fireEvent.click(screen.getByRole('button', { name: '确认记录' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'food', grams: 200, servingUnit: '份' }),
      );
    });
  });

  it('不同餐次（早餐已记、午餐再记同一食物）→ 不提示（那是正常的）', async () => {
    renderComposer({ existingMealItems: [existingRow({ mealType: 'breakfast', foodItemId: 7 })] });
    await selectFoodFromRecent('米饭');

    expect(screen.queryByTestId('same-meal-hint')).toBeNull();
  });

  it('不同日期 → 不提示', async () => {
    renderComposer({ existingMealItems: [existingRow({ loggedDate: '2026-09-11', foodItemId: 7 })] });
    await selectFoodFromRecent('米饭');

    expect(screen.queryByTestId('same-meal-hint')).toBeNull();
  });

  it('同日同餐但不同食物 → 不提示', async () => {
    renderComposer({ existingMealItems: [existingRow({ foodItemId: 99 })] });
    await selectFoodFromRecent('米饭');

    expect(screen.queryByTestId('same-meal-hint')).toBeNull();
  });

  it('文案红线：中性、无指责式说法，且提示元素不用红色', async () => {
    // 逐词钉死中性：绝不出现「重复 / 记错了 / 请注意 / 确定要」这类在说用户记错的措辞。
    const banned = ['重复', '记错', '错了', '请注意', '确定要', '请勿', '已经记过了'];
    for (const word of banned) {
      expect(COPY.sameMealHint).not.toContain(word);
    }
    expect(COPY.sameMealHint).toContain('接着记也没问题');

    renderComposer({ existingMealItems: [existingRow({ foodItemId: 7 })] });
    await selectFoodFromRecent('米饭');

    const hint = await screen.findByTestId('same-meal-hint');
    const text = hint.textContent ?? '';
    for (const word of banned) {
      expect(text).not.toContain(word);
    }
    // 无负罪感视觉约束：不得出现红色系类名（含 dark: 变体）
    expect(hint.className).not.toMatch(/red|rose|danger/i);
  });

  it('快加路径同源命中：名称与今天这一餐已记的自定义条目同名 → 提示', async () => {
    renderComposer({ existingMealItems: [existingRow({ customName: '楼下麻辣烫' })] });
    await openTab('快加');

    const nameInput = screen.getByPlaceholderText('如：楼下麻辣烫');
    fireEvent.change(nameInput, { target: { value: '楼下麻辣烫' } });

    expect(await screen.findByTestId('same-meal-hint-quick')).toBeInTheDocument();
  });

  it('多选路径同源命中：清单含今天已记过的项 → 提示，且仍能提交（默认放行）', async () => {
    const onSubmit = renderComposer({ existingMealItems: [existingRow({ foodItemId: 7 })] });
    await openTab('最近');

    // 打开多选模式 → 点食物只进清单、不入库
    fireEvent.click(screen.getByLabelText(COPY.multiSelectToggle));
    const row = await screen.findByText('米饭');
    fireEvent.click(row.closest('button') as HTMLElement);

    // 清单里的「米饭」今天这一餐已经记过 → 一句觉察
    expect(await screen.findByTestId('same-meal-hint-batch')).toBeInTheDocument();

    // 提示不挡路：直接提交整份清单，仍能成功
    fireEvent.click(screen.getByRole('button', { name: COPY.pendingConfirm(1) }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'batch' }));
    });
  });
});
