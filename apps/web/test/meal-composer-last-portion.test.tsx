/**
 * 「上次份量记忆」接线测试（pages/diary/MealComposer.tsx / D-1）。
 *
 * 背景：选中常吃的食物时，默认份量此前**恒定**取 `resolveDefaultServing(food)`（食物库通用默认），
 * 用户每天都得改回自己实际的量。D-1 让默认份量优先取「上次记这个食物用的份量」。本用例钉死：
 *
 * ① ★ **核心**：有历史份量时，选中食物后**默认值 = 上次份量**（不是库内默认）；
 * ② ★ **无历史回退**：没有历史 → 回退 `resolveDefaultServing(food)` 的结果（防回归）；
 * ③ **用户仍可改**：默认只是**填值**，份量输入框照常可改、单位按钮照常可用（不锁死）；
 * ④ **查询失败 / 离线 → 静默回退**：不报错、不弹任何提示、不阻塞；
 * ⑤ **文案红线**：提示语是中性的（无「失败 / 错误 / 崩溃」），也不用红色类名。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodItem, ServingUnit } from '@qsh/shared-types';
import MealComposer from '@/pages/diary/MealComposer';
import { COPY } from '@/lib/copy';

const TODAY = '2026-09-12';

/** 造一个食物库条目（字段与 `FoodItem` 契约一致）。 */
function makeFood(
  id: number,
  name: string,
  servingUnits: ServingUnit[],
  defaultServingGrams: number,
): FoodItem {
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
    defaultServingGrams,
    barcode: null,
    source: 'builtin',
    createdByUserId: null,
    isVerified: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

/** 「最近」tab 的食物列表（`GET /foods/recent`）。 */
let recentItems: FoodItem[] = [];
/** `GET /foods/last-portions` 的预置返回。 */
let lastPortions: Record<string, unknown> = {};
/** 让「上次份量」查询失败（验证静默回退）。 */
let failLastPortions = false;
/** 「上次份量」端点被请求的次数。 */
let lastPortionsCalls = 0;

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input);
      if (url.includes('/foods/last-portions')) {
        lastPortionsCalls += 1;
        if (failLastPortions) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ data: null, error: { code: 'E_BOOM', message: '服务端在开小差' } }),
          };
        }
        return ok({ portions: lastPortions });
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
      return ok([]);
    }),
  );
}

let client: QueryClient;

function renderComposer(): void {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MealComposer date={TODAY} mealType="lunch" onClose={() => undefined} onSubmit={vi.fn(async () => undefined)} />
    </QueryClientProvider>,
  );
}

/** 切到指定 tab。 */
async function openTab(name: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('tab', { name })).toBeInTheDocument();
  });
  fireEvent.click(screen.getByRole('tab', { name }));
}

/** 份量「克数」输入框。 */
function gramsInput(): HTMLInputElement {
  return screen.getByLabelText('克数') as HTMLInputElement;
}

/** 选中「最近」tab 里第一条食物（在喂了 last-portions 数据后点击，避免竞态）。 */
async function selectFood(row: HTMLElement, expectedGrams: string): Promise<void> {
  await waitFor(() => {
    fireEvent.click(row);
    expect(gramsInput().value).toBe(expectedGrams);
  });
}

/**
 * 选中食物、只等份量输入框**就绪**（不依赖具体默认值）。
 *
 * 用于「用户仍可改份量」「文案红线」这类**不关心默认值来源**的用例 ——
 * 它们只验证「输入可编辑 / 单位按钮可用 / 文案中性」，故不去断言默认值，
 * 从而保持单一职责：默认值来源只由 ★ 核心用例钉死（缺陷注入时只有它转红）。
 */
async function selectFoodReady(row: HTMLElement): Promise<void> {
  await waitFor(() => {
    fireEvent.click(row);
    expect(gramsInput().value).not.toBe('');
  });
}

beforeEach(() => {
  recentItems = [];
  lastPortions = {};
  failLastPortions = false;
  lastPortionsCalls = 0;
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('D-1 上次份量记忆', () => {
  it('★ 有历史份量 → 默认值 = 上次份量（不是库内默认），并给出中性小字', async () => {
    // 库内默认：1 份 = 200g；上次记的是 300g
    recentItems = [makeFood(7, '米饭', [{ unit: '份', grams: 200, label: '一份' }], 200)];
    lastPortions = { '7': { grams: 300, servingUnit: '克', servingQty: null } };

    renderComposer();
    await openTab('最近');

    const row = await screen.findByText('米饭');
    await selectFood(row.closest('button') as HTMLElement, '300');

    // 默认值来自历史（300），而不是库内默认（200）
    expect(gramsInput().value).toBe('300');

    // 中性小字说明（回显用户自己上次填的数）
    const hint = await screen.findByTestId('last-portion-hint');
    expect(hint.textContent).toBe('上次记的是 300g');
    // 文案红线（DOM 侧）：提示元素不得使用红色系类名（无负罪感 / NFR-11 视觉约束）
    expect(hint.className).not.toMatch(/red|rose|danger/i);
  });

  it('★ 无历史 → 回退 resolveDefaultServing（库内默认 200g），且不显示提示', async () => {
    recentItems = [makeFood(8, '面条', [{ unit: '份', grams: 200, label: '一份' }], 200)];
    lastPortions = { '8': null };

    renderComposer();
    await openTab('最近');

    const row = await screen.findByText('面条');
    await selectFood(row.closest('button') as HTMLElement, '200');

    expect(gramsInput().value).toBe('200');
    expect(screen.queryByTestId('last-portion-hint')).toBeNull();
    expect(lastPortionsCalls).toBeGreaterThan(0);
  });

  it('用户仍可改份量：输入框可编辑，单位按钮照常生效（默认只是填值）', async () => {
    recentItems = [
      makeFood(
        9,
        '燕麦',
        [
          { unit: '份', grams: 200, isDefault: true },
          { unit: '碗', grams: 150 },
        ],
        200,
      ),
    ];
    lastPortions = { '9': { grams: 300, servingUnit: '克', servingQty: null } };

    renderComposer();
    await openTab('最近');

    const row = await screen.findByText('燕麦');
    await selectFoodReady(row.closest('button') as HTMLElement);

    // ① 手动改克数 → 生效
    fireEvent.change(gramsInput(), { target: { value: '250' } });
    expect(gramsInput().value).toBe('250');

    // ② 点单位按钮 → 按该单位克数填回（未被锁死）
    fireEvent.click(screen.getByRole('button', { name: /1 碗（150g）/ }));
    expect(gramsInput().value).toBe('150');
  });

  it('★ 查询失败 / 离线 → 静默回退默认份量，不报错、不阻塞', async () => {
    recentItems = [makeFood(10, '馒头', [{ unit: '份', grams: 200, label: '一份' }], 200)];
    failLastPortions = true;

    renderComposer();
    await openTab('最近');

    const row = await screen.findByText('馒头');
    await selectFood(row.closest('button') as HTMLElement, '200');

    // 回退成功
    expect(gramsInput().value).toBe('200');
    expect(screen.queryByTestId('last-portion-hint')).toBeNull();
    // 确实发过请求（证明了失败路径，而不是「没查」）
    expect(lastPortionsCalls).toBeGreaterThan(0);
    // 不给出任何错误 / 提示横幅（静默）
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('文案红线：提示语中性、无「失败 / 错误 / 崩溃」等负罪感词（无负罪感 / PRD §7）', () => {
    // 提示语只是**回显用户自己上次填的数**，不是任何评价 / 建议 —— 逐词钉死中性。
    // （DOM 侧不得用红色类名，已由 ★ 核心用例的 `hint.className` 断言覆盖。）
    const banned = ['失败', '错误', '崩溃', '超标', '超出', '多了', '少'];
    for (const grams of [0.5, 1, 12.5, 250, 1234.5]) {
      const text = COPY.lastPortionHint(grams);
      for (const word of banned) {
        expect(text).not.toContain(word);
      }
      expect(text.startsWith('上次记的是 ')).toBe(true);
      expect(text.endsWith('g')).toBe(true);
    }
    // 具体格式：整数不带小数、非整数保留 1 位小数
    expect(COPY.lastPortionHint(250)).toBe('上次记的是 250g');
    expect(COPY.lastPortionHint(12.5)).toBe('上次记的是 12.5g');
  });
});
