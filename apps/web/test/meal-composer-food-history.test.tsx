/**
 * 食物食用历史（D-5）接线测试（pages/diary/MealComposer.tsx + FoodHistoryPanel.tsx）。
 *
 * 钉死的事：
 * ① ★ **常吃榜之外也能看到**（本任务的核心覆盖目标）：**搜索结果**与**最近**两个 tab
 *    的每一行都带「历史」动作 —— 此前「上次吃这道菜是什么时候」只有常吃榜有答案，
 *    而常吃榜要求「窗口内 ≥ 3 天」且只列前 12 条；
 * ② ★ **只读**：展开出来的是一份纯展示的日期列表，**没有任何写入入口**
 *    （没有「记一笔」按钮、点了不会调 `onSubmit`）；
 * ③ ★ **不嵌套 button**：历史按钮与「选食物」按钮是**平级兄弟**
 *    （`MealComposer` 既有结构约束：嵌套 `<button>` 是非法 HTML，读屏会读乱）；
 * ④ 🔴 **红线断言**（可 grep 校验）：文本不含 AC-11.5.3 黑名单词、不含「共 N 天 /
 *    N 次」汇总、无红/黄警示色类名、无 `role="meter"`、无营养字段；
 * ⑤ 展开 / 收起、加载中 / 空态 / 读取失败的软着陆；一次只展开一行。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodHistoryEntry, FoodHistoryResponse, FoodItem } from '@qsh/shared-types';
import MealComposer from '@/pages/diary/MealComposer';
import type { ComposerSubmit } from '@/pages/diary/MealComposer';
import { COPY } from '@/lib/copy';

const TODAY = '2026-09-12';

/** 造一个食物库条目（字段与契约一致）。 */
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
    servingUnits: [{ unit: '份', grams: 200, label: '一份' }],
    defaultServingGrams: 200,
    barcode: null,
    source: 'builtin',
    createdByUserId: null,
    isVerified: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

/** 造一条历史明细。 */
function makeEntry(overrides: Partial<FoodHistoryEntry> = {}): FoodHistoryEntry {
  return {
    loggedDate: '2026-09-08',
    mealType: 'lunch',
    grams: 150,
    servingUnit: '碗',
    servingQty: 1,
    ...overrides,
  };
}

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

function fail(status: number): { ok: false; status: number; json: () => Promise<unknown> } {
  return { ok: false, status, json: async () => ({ data: null, error: { code: 'E_UNKNOWN', message: 'x' } }) };
}

/** 各来源的食物列表（搜索 / 最近 / 收藏共用 `renderFoodList`，故三个都要能取到）。 */
let searchItems: FoodItem[] = [];
let recentItems: FoodItem[] = [];
let favoriteItems: FoodItem[] = [];

/** 每个食物 id 的历史（缺省 = 空列表）。 */
let historyByFood: Record<number, FoodHistoryEntry[]> = {};

/** 让某次 history 请求失败（测软着陆）。 */
let historyFailIds: number[] = [];

/** 记录所有发出的 history 请求 URL（断言「只在展开时才发」）。 */
let historyRequests: string[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/history')) {
        historyRequests.push(url);
        const matched = /\/foods\/(\d+)\/history/.exec(url);
        const foodId = matched?.[1] === undefined ? -1 : Number(matched[1]);
        if (historyFailIds.includes(foodId)) {
          return fail(500);
        }
        const response: FoodHistoryResponse = {
          foodId,
          name: `食物${foodId}`,
          items: historyByFood[foodId] ?? [],
        };
        return ok(response);
      }
      if (url.includes('/foods/live-search')) {
        return ok({ items: [], found: 0, skipped: 0, degraded: false, source: 'openfoodfacts', license: 'ODbL 1.0' });
      }
      if (url.includes('/foods/top')) {
        return ok({ days: 90, items: [] });
      }
      if (url.includes('/foods/favorites')) {
        return ok(favoriteItems);
      }
      if (url.includes('/foods/recent')) {
        return ok(recentItems);
      }
      if (url.includes('/meal-combos')) {
        return ok([]);
      }
      if (url.includes('/foods?') || url.includes('/api/foods')) {
        return ok({ items: searchItems, total: searchItems.length, page: 1, pageSize: 20 });
      }
      return ok({});
    }),
  );
}

let submitSpy: ReturnType<typeof vi.fn>;

function renderComposer(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  submitSpy = vi.fn(async (_payload: ComposerSubmit): Promise<void> => undefined);
  render(
    <QueryClientProvider client={client}>
      <MealComposer date={TODAY} mealType="lunch" onClose={() => undefined} onSubmit={submitSpy} />
    </QueryClientProvider>,
  );
}

/** 切到某个 tab 并等它渲染完。 */
async function openTab(label: string): Promise<void> {
  fireEvent.click(await screen.findByRole('tab', { name: label }));
}

/**
 * 展开某一行的历史并等**数据真的到位**。
 *
 * ⚠️ 必须等 `读取中…` 消失：面板标题是**同步**渲染的，只等标题会在数据回来前就返回，
 * 后面所有 `getByText('9月8日')` 都会扑空（这类「等错了东西」的失败最容易被误读成
 * 「功能没实现」）。
 */
async function openHistory(foodName: string, foodId: number): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: `看看 ${foodName} 什么时候吃过` }));
  await waitFor(() => {
    expect(screen.getByText(`${foodName} 什么时候吃过`)).toBeInTheDocument();
  });
  // 等这一块面板离开加载态
  await waitFor(() => {
    expect(within(panel(foodId)).queryByText(COPY.foodHistoryLoading)).not.toBeInTheDocument();
  });
}

/** 展开后的面板（用 testid 定位，避开列表行）。 */
function panel(foodId: number): HTMLElement {
  return screen.getByTestId(`food-history-${foodId}`);
}

beforeEach(() => {
  searchItems = [makeFood(1, '番茄炒蛋'), makeFood(2, '米饭')];
  recentItems = [makeFood(3, '紫菜汤'), makeFood(4, '豆腐')];
  favoriteItems = [makeFood(5, '全脂牛奶')];
  historyByFood = {
    1: [
      makeEntry({ loggedDate: '2026-09-10', mealType: 'dinner', grams: 200, servingUnit: null, servingQty: null }),
      makeEntry({ loggedDate: '2026-09-08', mealType: 'lunch' }),
      // 快加卡形态：没有份量
      makeEntry({ loggedDate: '2026-08-30', mealType: 'breakfast', grams: null, servingUnit: null, servingQty: null }),
    ],
    3: [makeEntry({ loggedDate: '2026-07-01', mealType: 'snack', grams: null, servingUnit: '碗', servingQty: 2 })],
    5: [makeEntry({ loggedDate: '2026-06-11', mealType: 'breakfast' })],
  };
  historyFailIds = [];
  historyRequests = [];
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('D-5 入口覆盖：常吃榜之外也能看到（核心目标）', () => {
  it('★ 搜索结果里每一行都有「历史」动作', async () => {
    renderComposer();
    fireEvent.change(await screen.findByLabelText('搜索食物'), { target: { value: '番茄' } });
    await waitFor(() => {
      expect(screen.getByText('番茄炒蛋')).toBeInTheDocument();
    });

    expect(
      screen.getByRole('button', { name: '看看 番茄炒蛋 什么时候吃过' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '看看 米饭 什么时候吃过' })).toBeInTheDocument();
  });

  it('★ 「最近」tab 里也能看到（不只搜索），并能真的展开', async () => {
    renderComposer();
    await openTab('最近');
    await waitFor(() => {
      expect(screen.getByText('紫菜汤')).toBeInTheDocument();
    });

    expect(
      screen.getByRole('button', { name: '看看 紫菜汤 什么时候吃过' }),
    ).toBeInTheDocument();
    await openHistory('紫菜汤', 3);
    expect(within(panel(3)).getByText('7月1日')).toBeInTheDocument();
  });

  it('★ 「收藏」tab 里也能看到', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });

    await openHistory('全脂牛奶', 5);
    expect(within(panel(5)).getByText('6月11日')).toBeInTheDocument();
  });

  it('★ 折叠状态下不发 history 请求（只在用户主动展开时才拉）', async () => {
    renderComposer();
    await openTab('最近');
    await waitFor(() => {
      expect(screen.getByText('紫菜汤')).toBeInTheDocument();
    });
    // 列表已渲染，但还没点过「历史」
    expect(historyRequests).toHaveLength(0);

    // 展开其中一个 → 只发**这一条**
    await openHistory('紫菜汤', 3);
    expect(historyRequests).toHaveLength(1);
    expect(historyRequests[0]).toContain('/foods/3/history');
  });

  it('一次只展开一行：展开 B 会收起 A', async () => {
    renderComposer();
    await openTab('最近');
    await waitFor(() => {
      expect(screen.getByText('紫菜汤')).toBeInTheDocument();
    });

    await openHistory('紫菜汤', 3);
    await openHistory('豆腐', 4);

    expect(screen.queryByTestId('food-history-3')).not.toBeInTheDocument();
    expect(screen.getByTestId('food-history-4')).toBeInTheDocument();
  });

  it('再点一次行内的「历史」→ 收起', async () => {
    renderComposer();
    await openTab('最近');
    await waitFor(() => {
      expect(screen.getByText('紫菜汤')).toBeInTheDocument();
    });

    await openHistory('紫菜汤', 3);
    // 展开后行内开关的 aria-label 变成「收起 …」
    fireEvent.click(screen.getByRole('button', { name: '收起 紫菜汤 的历史' }));
    await waitFor(() => {
      expect(screen.queryByTestId('food-history-3')).not.toBeInTheDocument();
    });
  });

  it('点面板里的「收起」也能收起（两个入口等价）', async () => {
    renderComposer();
    await openTab('最近');
    await waitFor(() => {
      expect(screen.getByText('紫菜汤')).toBeInTheDocument();
    });

    await openHistory('紫菜汤', 3);
    fireEvent.click(screen.getByRole('button', { name: '关掉 紫菜汤 的这份列表' }));
    await waitFor(() => {
      expect(screen.queryByTestId('food-history-3')).not.toBeInTheDocument();
    });
  });

  it('★ 展开态下两个「收起」入口的读屏名字**不重复**（否则用户分不清按哪个）', async () => {
    renderComposer();
    await openTab('最近');
    await waitFor(() => {
      expect(screen.getByText('紫菜汤')).toBeInTheDocument();
    });
    await openHistory('紫菜汤', 3);

    // 各只有一个，且两者名字不同
    expect(screen.getAllByRole('button', { name: '收起 紫菜汤 的历史' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '关掉 紫菜汤 的这份列表' })).toHaveLength(1);
  });
});

describe('D-5 展开内容：日期 + 餐次 + 份量', () => {
  /** 走到搜索结果并等「番茄炒蛋」那一行出现。 */
  async function gotoSearch(): Promise<void> {
    renderComposer();
    fireEvent.change(await screen.findByLabelText('搜索食物'), { target: { value: '番茄' } });
    await waitFor(() => {
      expect(screen.getByText('番茄炒蛋')).toBeInTheDocument();
    });
  }

  it('按服务端顺序渲染（日期倒序），客户端不重排', async () => {
    await gotoSearch();
    await openHistory('番茄炒蛋', 1);

    const dates = within(panel(1))
      .getAllByRole('listitem')
      .map((row) => row.textContent ?? '');
    // 9-10 → 9-8 → 8-30，**原样透传**服务端顺序
    expect(dates).toHaveLength(3);
    expect(dates[0]).toContain('9月10日');
    expect(dates[1]).toContain('9月8日');
    expect(dates[2]).toContain('8月30日');
  });

  it('每条含日期 + 餐次 + 份量', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);

    const row = within(panel(5)).getByRole('listitem');
    expect(row.textContent).toContain('6月11日');
    expect(row.textContent).toContain('早餐');
    expect(row.textContent).toContain('1 碗');
    expect(row.textContent).toContain('150 克');
  });

  it('★ 无份量时整段不渲染（不写「0 克」兜底）', async () => {
    await gotoSearch();
    await openHistory('番茄炒蛋', 1);

    const rows = within(panel(1)).getAllByRole('listitem');
    // 第三条是快加卡形态：grams/servingUnit/servingQty 全为 null
    const quickRow = rows[2] as HTMLElement;
    expect(quickRow.textContent).toContain('8月30日');
    expect(quickRow.textContent).toContain('早餐');
    // ⚠️ 断言必须精确到「数字 + 单位」，不能只查「0」—— 日期「8月30日」里就有 0。
    expect(quickRow.textContent).not.toMatch(/\d+(\.\d+)?\s*(克|g|碗|份|个|杯|片|袋)/);
    expect(quickRow.textContent).not.toMatch(/份量|未知/);
    // 有份量的那两条**确实**带了份量（证明上一条不是因为「压根没渲染」而空）
    expect(rows[0]?.textContent).toMatch(/\d+(\.\d+)?\s*克/);
  });

  it('aria-label 含日期 + 餐次 + 份量（读屏不因覆盖而丢信息，NFR-7）', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);

    const row = within(panel(5)).getByRole('listitem');
    const aria = row.getAttribute('aria-label') ?? '';
    expect(aria).toContain('6月11日');
    expect(aria).toContain('早餐');
    expect(aria).toContain('150 克');
    // 一个控件一个 aria-label：没有额外挂 aria-describedby 让读屏念两遍
    expect(row.hasAttribute('aria-describedby')).toBe(false);
  });

  it('无历史 → 给一句中性空态（不留白）', async () => {
    renderComposer();
    fireEvent.change(await screen.findByLabelText('搜索食物'), { target: { value: '米饭' } });
    await waitFor(() => {
      expect(screen.getByText('米饭')).toBeInTheDocument();
    });
    await openHistory('米饭', 2);

    expect(within(panel(2)).getByText(COPY.foodHistoryEmpty)).toBeInTheDocument();
    // 空态**不出现**任何汇总或评价
    expect(panel(2).textContent ?? '').not.toMatch(/共\s*\d+|一共|总共/);
  });

  it('读取失败 → 软着陆提示，且不暗示「没有历史」', async () => {
    historyFailIds = [5];
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);

    expect(within(panel(5)).getByText(COPY.foodHistoryError)).toBeInTheDocument();
    // 「没读到」≠「没记过」→ 不得出现空态那句话
    expect(within(panel(5)).queryByText(COPY.foodHistoryEmpty)).not.toBeInTheDocument();
  });
});

/**
 * ★ 只读：这份列表是「查看历史」，**不是**另一个记录入口。
 *
 * 一旦允许从这里直接写入，它就变成第二个功能了（且会绕过份量确认，热量必然失真）。
 */
describe('D-5 只读（不产生任何写入）', () => {
  it('★ 展开面板里没有任何「记一笔 / 确认记录 / 加入」这类写入按钮', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);

    // 面板内唯一的按钮是「收起」
    const buttons = within(panel(5)).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(COPY.foodHistoryCollapse);
  });

  it('★ 展开历史不会触发提交（onSubmit 一次都没被调用）', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);
    await waitFor(() => {
      expect(within(panel(5)).getByText('6月11日')).toBeInTheDocument();
    });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('★ 展开历史不会选中这一行（不弹份量确认区）', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);
    // 「选择份量」区没有出现 —— 说明点「历史」不等于「选中食物」
    expect(screen.queryByLabelText('选择份量')).not.toBeInTheDocument();
  });

  it('★ 展开区里的每一行都不可点（纯文本，不是按钮）', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);

    const row = within(panel(5)).getByRole('listitem');
    expect(row.querySelectorAll('button')).toHaveLength(0);
    expect(row.getAttribute('role')).not.toBe('button');
  });
});

/**
 * ★ 不嵌套 button（`MealComposer` 既有结构约束）。
 *
 * 食物行的 DOM 结构是：`<li>` >（选食物按钮 **||** 历史按钮 **||** 星号按钮）**||** 展开区。
 * 三个按钮互为**平级兄弟**，展开区是 `<li>` 的子节点而**不在任何按钮内部** ——
 * 嵌套 `<button>` 是非法 HTML，读屏会读乱。
 */
describe('D-5 不嵌套 button（结构约束）', () => {
  it('★ 历史按钮与「选食物」按钮是平级兄弟，且都不在对方内部', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });

    const row = screen.getByText('全脂牛奶').closest('li') as HTMLElement;
    const historyButton = screen.getByRole('button', { name: '看看 全脂牛奶 什么时候吃过' });
    const selectButton = screen.getByText('全脂牛奶').closest('button') as HTMLElement;
    const starButton = screen.getByRole('button', { name: '取消收藏 全脂牛奶' });

    // 三个按钮的**父节点是同一个** → 平级兄弟
    expect(historyButton.parentElement).toBe(selectButton.parentElement);
    expect(starButton.parentElement).toBe(selectButton.parentElement);
    // 互不嵌套
    expect(selectButton.contains(historyButton)).toBe(false);
    expect(historyButton.contains(selectButton)).toBe(false);
    expect(selectButton.querySelectorAll('button')).toHaveLength(0);
    expect(historyButton.querySelectorAll('button')).toHaveLength(0);
  });

  it('★ 展开后，历史按钮内部仍无嵌套 button（面板是它的兄弟、不是孩子）', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);

    const toggle = screen.getByRole('button', { name: '收起 全脂牛奶 的历史' });
    // 面板不在 toggle 内部
    expect(toggle.contains(screen.getByTestId('food-history-5'))).toBe(false);
    // 整行里没有「button 套 button」
    const row = screen.getByText('全脂牛奶').closest('li') as HTMLElement;
    for (const button of within(row).getAllByRole('button')) {
      expect(button.querySelectorAll('button')).toHaveLength(0);
    }
  });

  it('★ 历史按钮带 aria-expanded（读屏知道当前是展开还是收起）', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });

    const before = screen.getByRole('button', { name: '看看 全脂牛奶 什么时候吃过' });
    expect(before.getAttribute('aria-expanded')).toBe('false');
    await openHistory('全脂牛奶', 5);
    const after = screen.getByRole('button', { name: '收起 全脂牛奶 的历史' });
    expect(after.getAttribute('aria-expanded')).toBe('true');
    // aria-controls 指向真实存在的展开区（NFR-7：控件与它控制的内容要能被关联）
    const controls = after.getAttribute('aria-controls');
    expect(controls).toBe('food-history-panel-5');
    expect(document.getElementById(controls ?? '')).not.toBeNull();
  });

  it('★ 点「历史」不会冒泡去选中这一行（stopPropagation）', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '看看 全脂牛奶 什么时候吃过' }));
    await waitFor(() => {
      expect(screen.getByTestId('food-history-5')).toBeInTheDocument();
    });
    // 若冒泡了，外层「选食物」会触发、份量确认区会弹出
    expect(screen.queryByLabelText('选择份量')).not.toBeInTheDocument();
  });
});

/**
 * 🔴 红线断言（QD-6 / AC-11.5.3 / AC-11.5.4）—— 全部做成可 grep 的机械断言。
 *
 * 缺陷注入反验会对准这一组：把结果改成显示「共 N 天」汇总 → **恰好**这一组转红。
 */
describe('D-5 零红线（QD-6 / AC-11.5.3 / AC-11.5.4）', () => {
  /** AC-11.5.3 的文案黑名单（沿用常吃榜既有清单，一个字不多一个字不少）。 */
  const BANNED_WORDS = [
    '过多',
    '过量',
    '超标',
    '不健康',
    '少喝',
    '少吃',
    '建议替换',
    '热量炸弹',
    '含糖',
    '高钠',
    '推荐摄入',
  ];

  /** 把面板里所有可见文本 + 所有 aria-label 拼成一份，供黑名单扫描。 */
  function panelText(foodId: number): string {
    const root = panel(foodId);
    const aria = Array.from(root.querySelectorAll('[aria-label]'))
      .map((node) => node.getAttribute('aria-label') ?? '')
      .join(' ');
    return `${root.textContent ?? ''} ${aria}`;
  }

  it('🔴 不出现「共 N 天 / N 次」等汇总（QD-6）', async () => {
    // ⚠️ 同一时刻只展开一行，所以两个食物必须**分两轮**查 ——
    // 展开第二个会把第一个收起来，一次查两个只会拿到空 DOM（假绿）。
    renderComposer();
    fireEvent.change(await screen.findByLabelText('搜索食物'), { target: { value: '番茄' } });
    await waitFor(() => {
      expect(screen.getByText('番茄炒蛋')).toBeInTheDocument();
    });
    // 番茄炒蛋有 3 条记录 —— 正是「容易被人写成『共 3 天』」的那一屏
    await openHistory('番茄炒蛋', 1);
    expect(within(panel(1)).getAllByRole('listitem')).toHaveLength(3);

    const text = panelText(1);
    expect(text).not.toMatch(/共\s*\d+\s*(天|次|个|样)/);
    expect(text).not.toMatch(/一共|总共|合计|累计/);
    expect(text).not.toMatch(/出现了?\s*\d+\s*天/);
    expect(text).not.toMatch(/记录了\s*\d+/);
  });

  it('🔴 单条记录的食物也不被包装成「1 次」（汇总禁令与条数无关）', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);

    const text = panelText(5);
    expect(within(panel(5)).getAllByRole('listitem')).toHaveLength(1);
    expect(text).not.toMatch(/共\s*\d+|一共|总共|合计|累计|\d+\s*次/);
  });

  it('🔴 文案黑名单一个都不命中（含 aria-label）', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);

    const text = [
      COPY.foodHistoryToggle,
      COPY.foodHistoryCollapse,
      COPY.foodHistoryLoading,
      COPY.foodHistoryError,
      COPY.foodHistoryEmpty,
      COPY.foodHistoryFootnote,
      panelText(5),
    ].join(' ');

    for (const word of BANNED_WORDS) {
      expect(text).not.toContain(word);
    }
    // 健康暗示句式（不只是单个词）
    expect(text).not.toMatch(/吃得(有点)?频繁|已经\s*\d+\s*天没|隔了\s*\d+\s*天|建议|推荐/);
  });

  it('🔴 无营养字段文本（零营养评判，AC-11.5.3）', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);

    const text = panelText(5);
    for (const word of ['kcal', '千卡', '卡路里', '蛋白', '脂肪', '碳水', '热量', '营养']) {
      expect(text).not.toContain(word);
    }
  });

  it('🔴 无 role="meter"、无红/黄/橙警示色类名', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);

    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(panel(5).querySelectorAll('[role="meter"]')).toHaveLength(0);
    // 警示语义色一律不得用于这块面板
    expect(panel(5).innerHTML).not.toMatch(/red|amber|yellow|orange|rose/);
  });

  it('🔴 不做「隔了多少天 / 还剩几天」这类衍生计算（只列日期本身）', async () => {
    renderComposer();
    await openTab('收藏');
    await waitFor(() => {
      expect(screen.getByText('全脂牛奶')).toBeInTheDocument();
    });
    await openHistory('全脂牛奶', 5);

    expect(panelText(5)).not.toMatch(/\d+\s*天前|隔了|还有\s*\d+\s*天|已经\s*\d+\s*天/);
  });
});
