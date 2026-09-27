/**
 * B3「改份量」前端接线测试。
 *
 * 钉死六件事：
 * ① 每条记录都有**改份量**入口，且带完整 `aria-label`（「改「番茄炒蛋」的份量」）；
 * ② 食物库条目改的是**份量**：只发 `grams`（或 `servingUnit` + `servingQty`），
 *    **不发 kcal** —— 热量由服务端按食物库重算；
 * ③ 快速加卡条目（`foodItemId` 为空）改的是**热量**，发 `kcal`；
 * ④ 面板里的「改后约 N」用 `@qsh/core` 的 `scaleFoodNutrients` 现场算（与服务端同一函数）；
 * ⑤ 🔴 **无负罪感**：改份量前后都不出现「超标 / 超出预算 / 吃多了」这类字样（PRD §7）；
 * ⑥ 降级控件（上移 / 下移 / 移动到）不受影响 —— 入口是同层新增的按钮，不接管指针事件。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { FoodItem, ListMealsResponse, MealLog, MealType } from '@qsh/shared-types';
import DiaryPage from '@/pages/diary/DiaryPage';
import MealItemRow from '@/pages/diary/MealItemRow';
import { todayKey } from '@/lib/format';
import { cacheClearAll } from '@/lib/local-cache';

const TODAY = todayKey();

/** 建一条 `MealLog`（`foodItemId` 非空 = 食物库条目；为空 = 快速加卡条目）。 */
function makeLog(input: {
  id: number;
  name: string;
  foodItemId: number | null;
  kcal: number;
  grams: number | null;
  mealType?: MealType;
}): MealLog {
  return {
    id: input.id,
    userId: 1,
    loggedDate: TODAY,
    mealType: input.mealType ?? 'lunch',
    foodItemId: input.foodItemId,
    customName: input.name,
    grams: input.grams,
    servingUnit: null,
    servingQty: null,
    kcal: input.kcal,
    proteinG: null,
    fatG: null,
    carbG: null,
    fiberG: null,
    sodiumMg: null,
    source: input.foodItemId === null ? 'quick_add' : 'search',
    comboId: null,
    note: null,
    sortOrder: 0,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  };
}

/** 一条食物库条目：120 kcal / 100g，含一个「份 = 50g」单位。 */
function tomatoFood(): FoodItem {
  return {
    id: 11,
    name: '番茄炒蛋',
    namePinyin: null,
    aliases: [],
    category: '菜肴',
    kcalPer100g: 120,
    proteinGPer100g: 8,
    fatGPer100g: 7,
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
    servingUnits: [{ unit: '份', grams: 50 }],
    defaultServingGrams: 100,
    barcode: null,
    source: 'cfcd',
    createdByUserId: null,
    isVerified: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

/** 捕获到的 PATCH 请求。 */
let patched: Array<{ url: string; body: unknown }> = [];

function mealsResponse(logs: MealLog[]): ListMealsResponse {
  return {
    date: TODAY,
    groups: [
      { mealType: 'breakfast', logs: [], totalKcal: 0 },
      { mealType: 'lunch', logs, totalKcal: logs.reduce((sum, log) => sum + log.kcal, 0) },
      { mealType: 'dinner', logs: [], totalKcal: 0 },
      { mealType: 'snack', logs: [], totalKcal: 0 },
    ],
    totalKcal: logs.reduce((sum, log) => sum + log.kcal, 0),
  };
}

/** stub 一次 fetch：`/meals` 返回给定记录，`/foods/:id` 返回食物，PATCH 记录请求体。 */
function stubFetch(logs: MealLog[], food: FoodItem | null = tomatoFood()): void {
  patched = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/meals') && method === 'PATCH') {
        patched.push({ url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
        const id = Number(url.split('/').pop());
        return ok({
          entry: { ...logs.find((log) => log.id === id), grams: 250, kcal: 300 },
          dayTotals: { kcal: 300, proteinG: 0, fatG: 0, carbG: 0 },
        });
      }
      if (url.includes('/meals')) {
        return ok(mealsResponse(logs));
      }
      if (url.includes('/weights')) {
        return ok({ points: [], movingAverage7: [], stats: {}, forecast: [], goalProgress: null });
      }
      if (url.includes('/foods/')) {
        return food === null ? ok(null) : ok(food);
      }
      return ok([]);
    }),
  );
}

function renderDiary(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DiaryPage initialDate={TODAY} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  cacheClearAll();
});

describe('改份量入口（B3）', () => {
  it('每条都有「改份量」按钮，带完整 aria-label，且点击可打开面板', async () => {
    const log = makeLog({ id: 1, name: '番茄炒蛋', foodItemId: 11, kcal: 120, grams: 100 });
    const onEdit = vi.fn();
    render(<MealItemRow
      log={log}
      name="番茄炒蛋"
      kcalLabel="120 kcal"
      gramsLabel="100g"
      canMoveUp={false}
      canMoveDown={false}
      otherMeals={[]}
      onRemove={vi.fn()}
      onMoveUp={vi.fn()}
      onMoveDown={vi.fn()}
      onMoveTo={vi.fn()}
      onEdit={onEdit}
    />);

    const button = screen.getByLabelText('改「番茄炒蛋」的份量');
    fireEvent.click(button);
    expect(onEdit).toHaveBeenCalledWith(log);

    // 降级控件照常存在（新增入口不替换既有能力）
    expect(screen.getByLabelText('把「番茄炒蛋」上移')).toBeInTheDocument();
    expect(screen.getByLabelText('把「番茄炒蛋」下移')).toBeInTheDocument();
  });

  it('不传 onEdit 时不显示入口（不影响其它使用者）', () => {
    const log = makeLog({ id: 1, name: '番茄炒蛋', foodItemId: 11, kcal: 120, grams: 100 });
    render(<MealItemRow
      log={log}
      name="番茄炒蛋"
      kcalLabel="120 kcal"
      gramsLabel="100g"
      canMoveUp={false}
      canMoveDown={false}
      otherMeals={[]}
      onRemove={vi.fn()}
      onMoveUp={vi.fn()}
      onMoveDown={vi.fn()}
      onMoveTo={vi.fn()}
    />);
    expect(screen.queryByLabelText('改「番茄炒蛋」的份量')).not.toBeInTheDocument();
  });
});

describe('食物库条目改份量：只发份量，热量交给服务端重算', () => {
  it('改克数 → PATCH /meals/:id 只带 grams（不带 kcal）', async () => {
    const log = makeLog({ id: 1, name: '番茄炒蛋', foodItemId: 11, kcal: 120, grams: 100 });
    stubFetch([log]);
    renderDiary();

    fireEvent.click(await screen.findByLabelText('改「番茄炒蛋」的份量'));

    const dialog = await screen.findByRole('dialog', { name: '改一下份量' });
    const gramsInput = within(dialog).getByLabelText('番茄炒蛋 的克数');
    fireEvent.change(gramsInput, { target: { value: '250' } });

    // 预览用 core 同一公式算：120 × 250 ÷ 100 = 300
    await waitFor(() => {
      expect(within(dialog).getByText(/改后约 300 kcal/)).toBeInTheDocument();
    });

    fireEvent.click(within(dialog).getByRole('button', { name: '改好了' }));

    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });
    expect(patched[0]?.url).toContain('/meals/1');
    const body = patched[0]?.body as Record<string, unknown>;
    expect(body).toEqual({ grams: 250 });
    expect(body).not.toHaveProperty('kcal');
  });

  it('按份量单位改 → 发 servingUnit + servingQty', async () => {
    const log = makeLog({ id: 2, name: '番茄炒蛋', foodItemId: 11, kcal: 120, grams: 100 });
    stubFetch([log]);
    renderDiary();

    fireEvent.click(await screen.findByLabelText('改「番茄炒蛋」的份量'));
    const dialog = await screen.findByRole('dialog', { name: '改一下份量' });

    // 份量单位来自 `GET /foods/:id`，是异步到达的 —— 等到单位按钮出现再点
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: /份（50g）/ })).toBeInTheDocument();
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /份（50g）/ }));
    await waitFor(() => {
      expect((within(dialog).getByLabelText('番茄炒蛋 的克数') as HTMLInputElement).value).toBe('50');
    });

    fireEvent.click(within(dialog).getByRole('button', { name: '改好了' }));
    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });
    expect(patched[0]?.body).toEqual({ servingUnit: '份', servingQty: 1 });
  });

  it('🔴 改份量全程不出现「超标 / 超出预算 / 吃多了」这类字样', async () => {
    const log = makeLog({ id: 1, name: '番茄炒蛋', foodItemId: 11, kcal: 120, grams: 100 });
    stubFetch([log]);
    renderDiary();

    fireEvent.click(await screen.findByLabelText('改「番茄炒蛋」的份量'));
    const dialog = await screen.findByRole('dialog', { name: '改一下份量' });

    fireEvent.change(within(dialog).getByLabelText('番茄炒蛋 的克数'), { target: { value: '900' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '改好了' }));

    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });

    const text = document.body.textContent ?? '';
    for (const banned of ['超标', '超出预算', '超出', '吃多了', '过量', '警告']) {
      expect(text).not.toContain(banned);
    }
    // 只有一条中性播报：陈述「改过了」，不含任何评价
    expect(screen.getByText('「番茄炒蛋」的份量已更新，这条的热量按食物库重新算过了')).toBeInTheDocument();
  });
});

describe('快速加卡条目改热量（B3）', () => {
  it('没有食物库参照物时改的是热量本身：发 kcal', async () => {
    const log = makeLog({ id: 7, name: '楼下麻辣烫', foodItemId: null, kcal: 600, grams: null });
    stubFetch([log], null);
    renderDiary();

    fireEvent.click(await screen.findByLabelText('改「楼下麻辣烫」的份量'));
    const dialog = await screen.findByRole('dialog', { name: '改一下热量' });

    // 给的是热量输入，不是克数输入
    expect(within(dialog).queryByLabelText('楼下麻辣烫 的克数')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('楼下麻辣烫 的热量'), { target: { value: '450' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '改好了' }));

    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });
    expect(patched[0]?.body).toEqual({ kcal: 450 });
    expect(screen.getByText('「楼下麻辣烫」的热量已更新')).toBeInTheDocument();
  });

  it('热量填了非数字 → 给一句中性提示，不发请求', async () => {
    const log = makeLog({ id: 7, name: '楼下麻辣烫', foodItemId: null, kcal: 600, grams: null });
    stubFetch([log], null);
    renderDiary();

    fireEvent.click(await screen.findByLabelText('改「楼下麻辣烫」的份量'));
    const dialog = await screen.findByRole('dialog', { name: '改一下热量' });

    fireEvent.change(within(dialog).getByLabelText('楼下麻辣烫 的热量'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '改好了' }));

    await waitFor(() => {
      expect(within(dialog).getByText('热量填一个不小于 0 的数字就好')).toBeInTheDocument();
    });
    expect(patched).toHaveLength(0);
    expect(document.body.textContent ?? '').not.toContain('错误');
  });
});
