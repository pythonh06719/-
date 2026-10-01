/**
 * QA 独立证伪测试（严过关）—— 前端补完三项 R3.8 / R11.5 / R11.6。
 *
 * 与工程师自测**刻意错开**的三个角度：
 *
 * 1. **C · 降级路径（AC-3.8.7 一票否决项）**
 *    不渲染 `DiaryPage`、不挂载 `usePointerReorder`，直接把 `MealItemRow` 当独立组件渲染，
 *    **且不传 `onDragHandlePointerDown`**（拖拽完全不可用）。
 *    断言：三个降级控件照常在、**aria-label 是完整语句**、回调确实触发、
 *    边界用 `disabled` 而非隐藏、键盘路径（`<select>`）可达。
 *
 * 2. **D · 备份提示与记录概览的页面级接线**
 *    工程师的 `backup-hint.test.ts` 只测了 `backupHintCopy` **纯函数**，
 *    没有测「页面真的把它渲染出来了」。本文件在 `SettingsDataPage` 上断言
 *    `data-testid="backup-hint"` 的三态，并断言 C6 基座 `data-testid="last-backup"`
 *    **同时仍在**（回归保护：只增不删）。
 *
 * 3. **B · 常吃榜「tab 与面板一致性」**
 *    tab 的显隐用 `(topQuery.data?.items ?? []).length > 0`，
 *    面板的渲染却用过滤后的 `topItems.length > 0`（只保留 `food !== null`）。
 *    当榜单里**只有快加条目**（`food: null`）时，tab 会出现、面板却是空的。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodItem, MealLog, MealType, TopFoodItem, TopFoodsResponse } from '@qsh/shared-types';
import MealItemRow from '@/pages/diary/MealItemRow';
import MealComposer from '@/pages/diary/MealComposer';
import type { ComposerSubmit } from '@/pages/diary/MealComposer';
import SettingsDataPage from '@/pages/settings-data/SettingsDataPage';
import { COPY, backupHintCopy, mealMoveDownAria, mealMoveToAria, mealMoveUpAria } from '@/lib/copy';
import { LAST_BACKUP_KEY } from '@/lib/backup';
import { MEAL_TYPE_LABELS } from '@/pages/diary/meal-utils';

const TODAY = '2026-09-12';

/** 造一条 `MealLog`。 */
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

/** 「除本餐以外」的其余三个餐次（与 DiaryPage 的口径一致）。 */
function otherMealsOf(current: MealType): Array<{ mealType: MealType; label: string }> {
  return (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[])
    .filter((mealType) => mealType !== current)
    .map((mealType) => ({ mealType, label: MEAL_TYPE_LABELS[mealType] }));
}

// ---------------------------------------------------------------------------
// C · 降级控件组（拖拽完全不可用时）
// ---------------------------------------------------------------------------

describe('C · 降级控件组（不挂载拖拽 hook / AC-3.8.7）', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('C1 · 不传 onDragHandlePointerDown：拖拽手柄不渲染，但三个降级控件照常在', () => {
    const log = makeLog(1, '番茄炒蛋', 0);
    render(
      <ul>
        <MealItemRow
          log={log}
          name="番茄炒蛋"
          kcalLabel="200 kcal"
          gramsLabel="100 g"
          canMoveUp={false}
          canMoveDown
          otherMeals={otherMealsOf('lunch')}
          onRemove={() => undefined}
          onMoveUp={() => undefined}
          onMoveDown={() => undefined}
          onMoveTo={() => undefined}
        />
      </ul>,
    );

    // 拖拽不可用时手柄不出现
    expect(screen.queryByTestId('meal-drag-handle-1')).toBeNull();
    // 但三个降级控件一个不少
    expect(screen.getByLabelText(mealMoveUpAria('番茄炒蛋'))).toBeInTheDocument();
    expect(screen.getByLabelText(mealMoveDownAria('番茄炒蛋'))).toBeInTheDocument();
    expect(screen.getByLabelText(`把「番茄炒蛋」移动到另一餐`)).toBeInTheDocument();
    for (const meal of otherMealsOf('lunch')) {
      expect(screen.getByLabelText(mealMoveToAria('番茄炒蛋', meal.label))).toBeInTheDocument();
    }
  });

  it('C2 · aria-label 是完整语句（含食物名与目标餐次）', () => {
    render(
      <ul>
        <MealItemRow
          log={makeLog(2, '米饭', 1)}
          name="米饭"
          kcalLabel="150 kcal"
          gramsLabel={null}
          canMoveUp
          canMoveDown
          otherMeals={otherMealsOf('lunch')}
          onRemove={() => undefined}
          onMoveUp={() => undefined}
          onMoveDown={() => undefined}
          onMoveTo={() => undefined}
        />
      </ul>,
    );
    expect(screen.getByLabelText('把「米饭」上移')).toBeInTheDocument();
    expect(screen.getByLabelText('把「米饭」下移')).toBeInTheDocument();
    // 本餐（午餐）**不**出现在可移动目标里 —— 移动目标只有其余三餐
    expect(screen.getByLabelText('把「米饭」移动到早餐')).toBeInTheDocument();
    expect(screen.getByLabelText('把「米饭」移动到晚餐')).toBeInTheDocument();
    expect(screen.getByLabelText('把「米饭」移动到加餐')).toBeInTheDocument();
    expect(screen.queryByLabelText('把「米饭」移动到午餐')).toBeNull();
  });

  it('C3 · 边界用 disabled 而非隐藏控件（首条的上移、末条的下移仍在 DOM 里）', () => {
    render(
      <ul>
        <MealItemRow
          log={makeLog(3, '青菜', 0)}
          name="青菜"
          kcalLabel="50 kcal"
          gramsLabel={null}
          canMoveUp={false}
          canMoveDown={false}
          otherMeals={otherMealsOf('lunch')}
          onRemove={() => undefined}
          onMoveUp={() => undefined}
          onMoveDown={() => undefined}
          onMoveTo={() => undefined}
        />
      </ul>,
    );
    const up = screen.getByLabelText('把「青菜」上移') as HTMLButtonElement;
    const down = screen.getByLabelText('把「青菜」下移') as HTMLButtonElement;
    expect(up).toBeInTheDocument(); // 不是 queryBy（隐藏）→ 必须是 getBy
    expect(down).toBeInTheDocument();
    expect(up.disabled).toBe(true);
    expect(down.disabled).toBe(true);
    expect(up.hidden).toBe(false);
    expect(down.hidden).toBe(false);
  });

  it('C4 · 三个降级控件的回调都真的被触发（拖拽不可用时也能完成移动）', () => {
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    const onMoveTo = vi.fn();
    const onRemove = vi.fn();

    render(
      <ul>
        <MealItemRow
          log={makeLog(4, '鸡蛋', 0)}
          name="鸡蛋"
          kcalLabel="80 kcal"
          gramsLabel={null}
          canMoveUp
          canMoveDown
          otherMeals={otherMealsOf('lunch')}
          onRemove={onRemove}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onMoveTo={onMoveTo}
        />
      </ul>,
    );

    fireEvent.click(screen.getByLabelText('把「鸡蛋」上移'));
    expect(onMoveUp).toHaveBeenCalledWith(4);

    fireEvent.click(screen.getByLabelText('把「鸡蛋」下移'));
    expect(onMoveDown).toHaveBeenCalledWith(4);

    fireEvent.click(screen.getByLabelText('把「鸡蛋」移动到晚餐'));
    expect(onMoveTo).toHaveBeenCalledWith(4, 'dinner');

    fireEvent.click(screen.getByLabelText('删除 鸡蛋'));
    expect(onRemove).toHaveBeenCalledWith(4);
  });

  it('C5 · 键盘可达：移动到某餐的 <select> 留在 Tab 序列里（tabIndex 不为 -1）', () => {
    render(
      <ul>
        <MealItemRow
          log={makeLog(5, '豆腐', 0)}
          name="豆腐"
          kcalLabel="90 kcal"
          gramsLabel={null}
          canMoveUp
          canMoveDown
          otherMeals={otherMealsOf('lunch')}
          onRemove={() => undefined}
          onMoveUp={() => undefined}
          onMoveDown={() => undefined}
          onMoveTo={() => undefined}
        />
      </ul>,
    );
    const select = screen.getByLabelText('把「豆腐」移动到另一餐') as HTMLSelectElement;
    expect(select.tabIndex).not.toBe(-1);
    expect(select.disabled).toBe(false);
    // 读屏专用的等价按钮组**不**占据 Tab 序列（避免聚焦到不可见元素，WCAG 2.4.7）
    const srOnly = screen.getByLabelText('把「豆腐」移动到早餐') as HTMLButtonElement;
    expect(srOnly.tabIndex).toBe(-1);
  });

  it('C6 · 选中 <select> 里的目标餐次 → 触发移动到该餐', () => {
    const onMoveTo = vi.fn();
    render(
      <ul>
        <MealItemRow
          log={makeLog(6, '牛奶', 0)}
          name="牛奶"
          kcalLabel="120 kcal"
          gramsLabel={null}
          canMoveUp
          canMoveDown
          otherMeals={otherMealsOf('lunch')}
          onRemove={() => undefined}
          onMoveUp={() => undefined}
          onMoveDown={() => undefined}
          onMoveTo={onMoveTo}
        />
      </ul>,
    );
    const select = screen.getByLabelText('把「牛奶」移动到另一餐') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'breakfast' } });
    expect(onMoveTo).toHaveBeenCalledWith(6, 'breakfast');
  });
});

// ---------------------------------------------------------------------------
// D · 备份提示与记录概览的页面级接线
// ---------------------------------------------------------------------------

/** stub fetch：`/data/overview` 返回指定行，`/data/export` 返回空载荷。 */
function stubFetch(overviewRows: Array<{ key: string; count: number; firstDate: string | null; lastDate: string | null }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/data/overview')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { rows: overviewRows }, error: null }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: {}, error: null }) };
    }),
  );
}

function renderSettingsPage(): void {
  render(
    <MemoryRouter>
      <SettingsDataPage />
    </MemoryRouter>,
  );
}

function daysAgoIso(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

describe('D · ≥30 天温和提示 + 记录概览（页面级，QA 独立证伪）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('D1 · 45 天未备份 → 追加一行温和提示，且 C6 基座 last-backup 同时仍在', async () => {
    window.localStorage.setItem(LAST_BACKUP_KEY, daysAgoIso(45));
    stubFetch([
      { key: 'meals', count: 128, firstDate: '2026-05-02', lastDate: '2026-09-12' },
      { key: 'wins', count: 0, firstDate: null, lastDate: null },
    ]);

    renderSettingsPage();

    // C6 回归保护：事实陈述一行仍在
    expect(screen.getByTestId('last-backup')).toBeInTheDocument();
    expect(screen.getByTestId('last-backup')).toHaveTextContent('上次备份于 45 天前');

    // 新增的温和提示一行
    await waitFor(() => {
      expect(screen.getByTestId('backup-hint')).toBeInTheDocument();
    });
    const hint = screen.getByTestId('backup-hint').textContent ?? '';
    expect(hint).toContain('距离上次备份');
    expect(hint).not.toContain('危险');
    expect(hint).not.toContain('警告');
    expect(hint).not.toContain('你已经');
    expect(backupHintCopy(45)).not.toBeNull();
  });

  it('D2 · 5 天前刚备份 → 不出现任何额外提示（< 30 天静默）', async () => {
    window.localStorage.setItem(LAST_BACKUP_KEY, daysAgoIso(5));
    stubFetch([]);

    renderSettingsPage();
    expect(screen.getByTestId('last-backup')).toHaveTextContent('上次备份于 5 天前');
    await waitFor(() => {
      expect(screen.getByTestId('last-backup')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('backup-hint')).toBeNull();
  });

  it('D3 · 从未备份 → 只有中性引导语，没有额外提示（不制造焦虑）', async () => {
    stubFetch([]);
    renderSettingsPage();
    expect(screen.getByTestId('last-backup')).toHaveTextContent(COPY.dataBackupNever);
    await waitFor(() => {
      expect(screen.getByTestId('last-backup')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('backup-hint')).toBeNull();
  });

  it('D4 · 记录概览：有记录的行渲染，count = 0 的 wins 行整行隐藏', async () => {
    stubFetch([
      { key: 'weights', count: 30, firstDate: '2026-08-01', lastDate: '2026-09-12' },
      { key: 'meals', count: 128, firstDate: '2026-05-02', lastDate: '2026-09-12' },
      { key: 'exercises', count: 0, firstDate: null, lastDate: null },
      { key: 'habits', count: 0, firstDate: null, lastDate: null },
      { key: 'water', count: 0, firstDate: null, lastDate: null },
      { key: 'wins', count: 0, firstDate: null, lastDate: null },
    ]);

    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId('overview-row-meals')).toBeInTheDocument();
    });
    expect(screen.getByTestId('overview-row-weights')).toBeInTheDocument();
    // count = 0 的行（含 wins）整行不渲染
    expect(screen.queryByTestId('overview-row-wins')).toBeNull();
    expect(screen.queryByTestId('overview-row-exercises')).toBeNull();
    expect(screen.queryByTestId('overview-row-habits')).toBeNull();
    expect(screen.queryByTestId('overview-row-water')).toBeNull();
  });

  it('D5 · 概览行只有「条数 + 跨度」，不含任何评价词', async () => {
    stubFetch([{ key: 'meals', count: 128, firstDate: '2026-05-02', lastDate: '2026-09-12' }]);
    renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByTestId('overview-row-meals')).toBeInTheDocument();
    });
    const text = screen.getByTestId('overview-row-meals').textContent ?? '';
    for (const banned of ['异常', '离群', '偏多', '偏少', '不足', '警告', '危险', '注意']) {
      expect(text).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// B · 常吃榜 tab 与面板的一致性
// ---------------------------------------------------------------------------

function renderComposer(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSubmit = vi.fn(async (_payload: ComposerSubmit): Promise<void> => undefined);
  render(
    <QueryClientProvider client={client}>
      <MealComposer date={TODAY} mealType="lunch" onClose={() => undefined} onSubmit={onSubmit} />
    </QueryClientProvider>,
  );
}

/** 造一个食物库条目（供「可点」的正向对照用例使用）。 */
function makeFood(id: number, name: string): FoodItem {
  return {
    id,
    name,
    namePinyin: null,
    aliases: [],
    category: '家常菜',
    kcalPer100g: 120,
    proteinGPer100g: 5,
    fatGPer100g: 4,
    carbGPer100g: 15,
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
    servingUnits: [{ unit: '份', grams: 200, label: '一份', isDefault: true }],
    defaultServingGrams: 200,
    barcode: null,
    source: 'builtin',
    createdByUserId: null,
    isVerified: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function stubTop(items: TopFoodItem[]): void {
  const payload: TopFoodsResponse = { days: 90, items };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/foods/top')) {
        return { ok: true, status: 200, json: async () => ({ data: payload, error: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { items: [], total: 0, page: 1, pageSize: 20 }, error: null }) };
    }),
  );
}

/**
 * 等「常吃」tab 真正出现（接口已 settle）；等不到返回 `null`（= 整块隐藏，可接受）。
 *
 * ⚠️ 必须**先等数据 settle**再判定：若不等待，tab 尚未渲染时会误判成「已隐藏」，
 * 这条用例就会变成一条永远通过的假绿测试。
 */
async function findTopTab(): Promise<HTMLElement | null> {
  try {
    await waitFor(
      () => {
        expect(screen.queryByRole('tab', { name: COPY.topFoodsTab })).not.toBeNull();
      },
      { timeout: 2000 },
    );
    return screen.getByRole('tab', { name: COPY.topFoodsTab });
  } catch {
    return null;
  }
}

describe('B · 常吃榜 tab 与面板一致性（QA 独立证伪）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /**
   * BUG-QA-01（P2，前端 UI 一致性）—— **已修复**，本用例断言修复后行为：
   *
   * 原缺陷：「常吃」tab 的显隐条件是 `(topQuery.data?.items ?? []).length > 0`（**未过滤**），
   * 而面板渲染用的是 `topItems.length > 0`（已过滤掉 `food === null` 的快加条目）。
   * 当榜单里**只有快加条目**时：tab 出现 → 点进去一片空白，既没有条目、也没有任何说明。
   *
   * 修复（MealComposer.tsx）：tab 显隐与面板渲染**同源**，都走过滤后的 `topItems`。
   * 因此榜单只有 `food: null` 条目时，tab **整块不出现**（AC-11.5.2「不留空卡」）。
   */
  it('B-QA1 · 榜单只有快加条目时「常吃」tab 整块隐藏（BUG-QA-01 已修复）', async () => {
    stubTop([
      { name: '自制酸奶', dayCount: 5, foodItemId: null, food: null, lastLoggedDate: '2026-09-09' },
      { name: '手冲咖啡', dayCount: 4, foodItemId: null, food: null, lastLoggedDate: '2026-09-07' },
    ]);
    renderComposer();

    // 修复后：tab 显隐与面板同源（都用过滤后的 topItems），只有 food:null 条目时 tab 不出现。
    const topTab = await findTopTab();
    expect(topTab).toBeNull();
    // 空白面板也就不存在了 —— 「常吃」面板标题不会在未选中时渲染。
    expect(screen.queryByText(COPY.topFoodsTitle)).toBeNull();
  });

  it('B-QA2 · 有可点条目时，tab 与面板一致（正向对照）', async () => {
    stubTop([
      { name: '番茄炒蛋', dayCount: 12, foodItemId: 1, food: makeFood(1, '番茄炒蛋'), lastLoggedDate: '2026-09-08' },
    ]);
    renderComposer();

    const topTab = await findTopTab();
    expect(topTab).not.toBeNull();
    fireEvent.click(topTab as HTMLElement);
    await waitFor(() => {
      expect(screen.getByText('番茄炒蛋')).toBeInTheDocument();
    });
  });
});
