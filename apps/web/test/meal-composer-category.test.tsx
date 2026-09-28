/**
 * 分类浏览入口（A2 / R3.4）接线测试（pages/diary/MealComposer.tsx）。
 *
 * 钉死九件事：
 * ① 分类 chip 行按 `FOOD_CATEGORIES` 的**展示序**渲染（不照搬接口顺序）：服务端给的是
 *    码点序、`other` 会在首位，前端把它重排到末位；枚举外的未知分类**原样保留**并排末位；
 * ② 选中某个分类 → `GET /foods/search` 带上 `category=<该分类>`；请求**不携带关键词**
 *    （`q` 键缺席 —— `buildUrl` 对空串一律不发，服务端与空关键词等价，详见该用例注释）；
 *    真正区分「按分类浏览」与「忘传关键词」的是 `enabled`（用例 ⑦）。
 * ③ 列表复用既有 `renderFoodList` → 点食物仍然进入**份量确认**，不是死列表；
 * ④ 再点同一 chip = 取消选中（列表消失、回到引导文案）；
 * ⑤ 换一个分类 → 请求换成新的 `category`；
 * ⑥ 服务端 `total` 如实呈现 +「加载更多」按 total 稳定翻页、不重复；
 * ⑦ 未选分类时**不请求** `/foods/search`（`enabled` 生效，不打无意义请求）；
 * ⑧ **键盘路径**：焦点放在 chip 上直接敲 `{Enter}` 就能选中并加载
 *    （本项目出现过「测试全绿但功能是坏的」盲区，键盘路径是硬要求）；
 * ⑨ 文案中性：整块面板不含「推荐 / 更健康 / 低卡 / 评分 / 等级 / 过量」这类词
 *    —— 分类浏览只是换个入口看库里的东西，绝不暗示哪一类更该吃。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FOOD_CATEGORIES, foodCategoryLabel } from '@qsh/core';
import type { FoodItem, FoodSearchHit, FoodSearchResponse } from '@qsh/shared-types';
import MealComposer from '@/pages/diary/MealComposer';
import { COPY } from '@/lib/copy';
import { emojiForCategory } from '@/lib/food-emoji';

/**
 * 接口当前**真实返回**的 9 个分类 —— 注意是**码点序**，不是展示序。
 *
 * 后端 `orderBy: { category: 'asc' }` 落在 SQLite 上就是 Unicode 码点比较，
 * 于是 `other`（`o` = U+006F）排在所有汉字之前，其余也非拼音序
 * （`家常菜` 夹在 `奶茶` 与 `水果` 之间）。这正是 P0 要修的问题，
 * 故测试**必须**从这个真实形状出发，而不是喂一个已经排好的数组。
 */
const REAL_CODEPOINT_ORDER = ['other', '主食', '外卖', '奶茶', '家常菜', '水果', '蔬菜', '蛋白', '零食'];

/** 造一条分类列表里的食物（契约字段与 `FoodSearchHit` 一致）。 */
function makeHit(id: number, name: string, category: string, kcalPer100g = 100): FoodSearchHit {
  const food: FoodItem = {
    id,
    name,
    namePinyin: null,
    aliases: [],
    category,
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
    servingUnits: [{ unit: '份', grams: 200, label: '一份' }],
    defaultServingGrams: 200,
    barcode: null,
    source: 'cfcd',
    createdByUserId: null,
    isVerified: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  return { ...food, qualifier: null, matchRank: 0 };
}

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

/** 记录每一次 `/foods/search` 请求的完整 URL（断言 `category` / `q` / `page` 用）。 */
let searchUrls: string[] = [];
/** 记录 `/foods/categories` 被请求了几次（断言「只在分类 tab 下请求」）。 */
let categoriesCalls = 0;

/** 每个分类的预置响应（按 `category` 参数返回，分页数组下标 = page - 1）。 */
let pagesByCategory: Record<string, FoodSearchResponse[]> = {};

/** `/foods/categories` 的预置返回（默认 = 后端真实码点序）。 */
let categoriesPayload: string[] = REAL_CODEPOINT_ORDER;

/**
 * stub `fetch`：
 * - `/foods/categories` → `categoriesPayload`；
 * - `/foods/search` → 记下 URL，再按 `category` 查预置分页（未预置 = 空页）。
 */
function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/foods/categories')) {
      categoriesCalls += 1;
      return ok(categoriesPayload);
    }
    if (url.includes('/foods/search')) {
      searchUrls.push(url);
      const parsed = new URL(url, 'http://localhost');
      const category = parsed.searchParams.get('category') ?? '';
      const page = Number(parsed.searchParams.get('page') ?? '1');
      const preset = pagesByCategory[category] ?? [];
      return ok(preset[page - 1] ?? { items: [], total: 0, page, pageSize: 20 });
    }
    // 在线兜底：分类浏览**不该**走到这里（本文件不含 live-search 用例，保留只为兜底不抛错）
    if (url.includes('/foods/live-search')) {
      return ok({ items: [], found: 0, skipped: 0, degraded: false, source: 'openfoodfacts', license: 'ODbL 1.0' });
    }
    if (url.includes('/foods/top')) {
      return ok({ days: 90, items: [] });
    }
    return ok([]);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderComposer(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MealComposer date="2026-09-12" mealType="lunch" onClose={vi.fn()} onSubmit={vi.fn(async () => undefined)} />
    </QueryClientProvider>,
  );
}

/** 某个 `/foods/search` 请求 URL 里的查询参数。 */
function paramsOf(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams;
}

/** 切到「分类」tab，并等到 chip 行出现。 */
async function openCategoryTab(): Promise<void> {
  const user = userEvent.setup();
  const tab = screen.getByRole('tab', { name: COPY.foodCategoryTab });
  tab.focus();
  await user.keyboard('{Enter}');
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '分类：主食' })).toBeInTheDocument();
  });
}

/** 点某个分类 chip（用读屏标签定位，与用户实际「听到的」一致 —— 标签是**展示名**）。 */
async function pickCategory(category: string): Promise<void> {
  const user = userEvent.setup();
  const chip = screen.getByRole('button', { name: `分类：${foodCategoryLabel(category)}` });
  chip.focus();
  await user.keyboard('{Enter}');
}

/** 取某个分类 chip 的可访问名（`other` → 「分类：其他」）。 */
function chipAriaName(category: string): string {
  return `分类：${foodCategoryLabel(category)}`;
}

/**
 * 切到「分类」tab，等待**分类请求跑完**（用于分类列表为空、chip 永远不出现的场景）。
 *
 * 不能复用 `openCategoryTab`（它等的是某个 chip 出现，空列表场景会一直等到超时）。
 */
async function openCategoryTabEmpty(): Promise<void> {
  const user = userEvent.setup();
  const tab = screen.getByRole('tab', { name: COPY.foodCategoryTab });
  tab.focus();
  await user.keyboard('{Enter}');
  await waitFor(() => {
    expect(categoriesCalls).toBeGreaterThan(0);
    // 读请求已结束后，空态才会渲染（`isLoading === false` 条件）
    expect(screen.getByText(COPY.foodCategoryListEmpty)).toBeInTheDocument();
  });
}

beforeEach(() => {
  searchUrls = [];
  categoriesCalls = 0;
  pagesByCategory = {};
  categoriesPayload = REAL_CODEPOINT_ORDER;
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('分类浏览（A2）：chip 按展示序排列，选中才取数', () => {
  it('切到分类 tab → 请求 `/foods/categories`，9 个 chip 全部渲染', async () => {
    renderComposer();
    await openCategoryTab();

    expect(categoriesCalls).toBeGreaterThan(0);

    // chip 的读屏标签就是「分类：X」；9 个分类一个不少
    const chipNames = REAL_CODEPOINT_ORDER.map((category) => chipAriaName(category));
    const rendered = chipNames.map((name) => screen.getByRole('button', { name }));
    expect(rendered).toHaveLength(9);
    for (const chip of rendered) {
      expect(chip).toBeInTheDocument();
    }

    // 展示名逐个可见：中文类原样，`other` 显示为「其他」（不再是英文裸露）
    for (const category of REAL_CODEPOINT_ORDER) {
      expect(screen.getByText(foodCategoryLabel(category))).toBeInTheDocument();
    }

    // 未选中任何分类 → 只有引导语，不请求 /foods/search
    expect(screen.getByText(COPY.foodCategoryPrompt)).toBeInTheDocument();
    expect(searchUrls).toEqual([]);
  });

  it('chip 顺序按 `FOOD_CATEGORIES` 重排：`other` 从首位挪到末位（P0 回归护栏）', async () => {
    renderComposer();
    await openCategoryTab();

    const chips = screen.getAllByRole('button', { name: /^分类：/ });
    expect(chips).toHaveLength(FOOD_CATEGORIES.length);

    // 绝对顺序 = `FOOD_CATEGORIES` 逐位对齐（chip 文本 = `emoji + 展示名`，故按展示名比对）
    const texts = chips.map((chip) => chip.textContent ?? '');
    for (const [index, category] of FOOD_CATEGORIES.entries()) {
      expect(texts[index]).toBe(`${emojiForCategory(category)}${foodCategoryLabel(category)}`);
    }

    // 关键点位：`other` 是最后一位（服务端码点序里它是第一位）
    expect(texts[texts.length - 1]).toBe('🍴其他');
    expect(REAL_CODEPOINT_ORDER[0]).toBe('other'); // 前提：stub 喂的确实是码点序
    // 相对顺序抽查：`other` 必须排在全部中文分类之后
    const otherIndex = texts.findIndex((text) => text.endsWith(foodCategoryLabel('other')));
    for (const category of FOOD_CATEGORIES) {
      if (category === 'other') continue;
      const index = texts.findIndex((text) => text.endsWith(foodCategoryLabel(category)));
      expect(otherIndex).toBeGreaterThan(index);
    }
  });

  it('数组外的未知分类仍被渲染且排在最后（不丢数据、不让 `indexOf === -1` 污染排序）', async () => {
    // 后端将来新增分类时会走到这里：`FOOD_CATEGORIES.indexOf` 返回 -1
    categoriesPayload = [...REAL_CODEPOINT_ORDER, '未来新类'];

    renderComposer();
    await openCategoryTab();

    const chips = screen.getAllByRole('button', { name: /^分类：/ });
    expect(chips).toHaveLength(10);
    // 未知分类照常显示，不抛错、不丢其他分类
    expect(screen.getByRole('button', { name: '分类：未来新类' })).toBeInTheDocument();
    for (const category of REAL_CODEPOINT_ORDER) {
      expect(screen.getByRole('button', { name: chipAriaName(category) })).toBeInTheDocument();
    }
    // 未知分类排在最后（而不是因 -1 插到队首）
    const texts = chips.map((chip) => chip.textContent ?? '');
    expect(texts[texts.length - 1]).toBe('🍴未来新类'); // 枚举外 → 原样展示
    // 已知分类之间仍按 FOOD_CATEGORIES 的相对顺序
    for (const [index, category] of FOOD_CATEGORIES.entries()) {
      expect(texts[index]?.endsWith(foodCategoryLabel(category))).toBe(true);
    }
  });

  it('未选分类时不请求 `/foods/search`（enabled 生效，不打无意义请求）', async () => {
    renderComposer();
    await openCategoryTab();

    // 给足微任务时间：若 enabled 写错，这里会捕获到多余请求
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(searchUrls).toEqual([]);
    expect(categoriesCalls).toBeGreaterThan(0);
  });

  it('点击某个分类 → 请求带上 `category`，且不携带任何关键词（纯分类浏览）', async () => {
    pagesByCategory['主食'] = [
      { items: [makeHit(1, '米饭', '主食', 116), makeHit(2, '馒头', '主食', 223)], total: 2, page: 1, pageSize: 20 },
    ];

    renderComposer();
    await openCategoryTab();
    await pickCategory('主食');

    await waitFor(() => {
      expect(searchUrls).toHaveLength(1);
    });

    const params = paramsOf(searchUrls[0] as string);
    expect(params.get('category')).toBe('主食');
    /*
     * `q` **键缺席**（`buildUrl` 对空串一律不发，见 `lib/api.ts`），这已足够：
     * `searchRanked`（`foods.service.ts:163`）对 `q` 取 `(dto.q ?? dto.keyword ?? '').trim()`
     * 后按 `length > 0` 才加关键词过滤，故「`q` 键缺席」与「`q` 为空」在**服务端完全等价**，
     * 两者都会得到「该分类下的全部食物」。
     *
     * 真正区分「按分类浏览」与「忘传关键词」的**不是 URL 上的 `q`**，而是 `enabled`
     * —— 未选分类时压根不发这条请求（见「未选分类时不请求 `/foods/search`」那条用例）。
     * 别再试图靠 `buildUrl` 发 `q=` 来验证意图：那既改不动服务端行为，也会破坏
     * 「`undefined` / `null` / 空串一律不发」这条全站共享的参数约定。
     */
    expect(params.get('q')).toBeNull();
    expect(params.get('page')).toBe('1');
    // 选中态：chip 是切换按钮，用 aria-pressed 表达（不是 tablist）
    expect(screen.getByRole('button', { name: '分类：主食' })).toHaveAttribute('aria-pressed', 'true');
    // 引导语让位给列表
    expect(screen.queryByText(COPY.foodCategoryPrompt)).not.toBeInTheDocument();
  });

  it('⌨️ 键盘路径：焦点放在 chip 上敲 Enter 就能选中并加载（不依赖鼠标）', async () => {
    pagesByCategory['水果'] = [
      { items: [makeHit(11, '苹果', '水果', 53)], total: 1, page: 1, pageSize: 20 },
    ];

    renderComposer();
    await openCategoryTab();

    const chip = screen.getByRole('button', { name: '分类：水果' });
    chip.focus();
    expect(chip).toHaveFocus();

    await userEvent.setup().keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByText('苹果')).toBeInTheDocument();
    });
    expect(paramsOf(searchUrls[0] as string).get('category')).toBe('水果');
  });

  it('点击分类后渲染该类食物 → 点食物进入「份量确认」（复用既有记录流程，不是死列表）', async () => {
    pagesByCategory['家常菜'] = [
      { items: [makeHit(21, '番茄炒蛋', '家常菜', 120)], total: 1, page: 1, pageSize: 20 },
    ];

    renderComposer();
    await openCategoryTab();
    await pickCategory('家常菜');

    await waitFor(() => {
      expect(screen.getByText('番茄炒蛋')).toBeInTheDocument();
    });

    // 点列表项（列表项的可访问名 = emoji + 名称 + 分类/热量，故按名称正则定位，
    // 与既有测试 `getAllByRole('listitem')` 的做法一致：不依赖 data-testid）
    await userEvent.setup().click(screen.getByRole('button', { name: /番茄炒蛋/ }));

    // 份量确认区出现 —— 证明走的是同一条「份量确认 → 确认记录」路径
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认记录' })).toBeInTheDocument();
    });
    expect(screen.getByText(/预估/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一份（200g）' })).toBeInTheDocument();
  });

  it('再点一次同一分类 = 取消选中（列表消失、回到引导文案）', async () => {
    pagesByCategory['蔬菜'] = [
      { items: [makeHit(31, '西兰花', '蔬菜', 36)], total: 1, page: 1, pageSize: 20 },
    ];

    renderComposer();
    await openCategoryTab();
    await pickCategory('蔬菜');

    await waitFor(() => {
      expect(screen.getByText('西兰花')).toBeInTheDocument();
    });

    await pickCategory('蔬菜');

    await waitFor(() => {
      expect(screen.queryByText('西兰花')).not.toBeInTheDocument();
    });
    expect(screen.getByText(COPY.foodCategoryPrompt)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '分类：蔬菜' })).toHaveAttribute('aria-pressed', 'false');
    // 取消选中后不再额外发请求
    expect(searchUrls).toHaveLength(1);
  });

  it('切换到别的分类 → 请求换成新的 `category`（同一时刻只选一个）', async () => {
    pagesByCategory['水果'] = [{ items: [makeHit(41, '苹果', '水果', 53)], total: 1, page: 1, pageSize: 20 }];
    pagesByCategory['奶茶'] = [{ items: [makeHit(42, '拿铁', '奶茶', 45)], total: 1, page: 1, pageSize: 20 }];

    renderComposer();
    await openCategoryTab();
    await pickCategory('水果');

    await waitFor(() => {
      expect(screen.getByText('苹果')).toBeInTheDocument();
    });

    await pickCategory('奶茶');

    await waitFor(() => {
      expect(screen.getByText('拿铁')).toBeInTheDocument();
    });
    // 旧分类的条目不再显示
    expect(screen.queryByText('苹果')).not.toBeInTheDocument();
    expect(paramsOf(searchUrls[searchUrls.length - 1] as string).get('category')).toBe('奶茶');
    expect(screen.getByRole('button', { name: '分类：水果' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '分类：奶茶' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('分页：第 1 页 2 条 + 第 2 页 1 条 = 3 条 →「加载更多」追加、不重复、按钮消失', async () => {
    pagesByCategory['零食'] = [
      {
        items: [makeHit(51, '苏打饼干', '零食', 408), makeHit(52, '薯片', '零食', 548)],
        total: 3,
        page: 1,
        pageSize: 2,
      },
      { items: [makeHit(53, '黑巧克力', '零食', 589)], total: 3, page: 2, pageSize: 2 },
    ];

    renderComposer();
    await openCategoryTab();
    await pickCategory('零食');

    await waitFor(() => {
      expect(screen.getByText('共 3 条，已显示 2 条')).toBeInTheDocument();
    });

    await userEvent.setup().click(screen.getByRole('button', { name: '加载更多' }));

    await waitFor(() => {
      expect(screen.getByText('共 3 条，已显示 3 条')).toBeInTheDocument();
    });

    // 累加而非替换，且三条各不相同（无重复）
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent ?? '');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('苏打饼干');
    expect(rows[2]).toContain('黑巧克力');
    expect(new Set(rows).size).toBe(3);

    // 翻到第 2 页，且分类参数保持
    expect(searchUrls.map((url) => paramsOf(url).get('page'))).toEqual(['1', '2']);
    expect(paramsOf(searchUrls[1] as string).get('category')).toBe('零食');
    // 全部加载完 → 按钮消失（不留死按钮）
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
  });

  it('换分类时收起上一轮选中的食物（份量确认区不残留）', async () => {
    pagesByCategory['水果'] = [{ items: [makeHit(81, '苹果', '水果', 53)], total: 1, page: 1, pageSize: 20 }];
    pagesByCategory['奶茶'] = [{ items: [makeHit(82, '拿铁', '奶茶', 45)], total: 1, page: 1, pageSize: 20 }];

    renderComposer();
    await openCategoryTab();
    await pickCategory('水果');

    await waitFor(() => {
      expect(screen.getByText('苹果')).toBeInTheDocument();
    });

    // 选中一条食物 → 份量确认区出现
    await userEvent.setup().click(screen.getByRole('button', { name: /苹果/ }));
    await waitFor(() => {
      expect(screen.getByText(/预估/)).toBeInTheDocument();
    });

    // 再点**另一个**分类 chip → 列表整体换掉，份量确认区必须跟着收起
    await pickCategory('奶茶');

    await waitFor(() => {
      expect(screen.queryByText(/预估/)).not.toBeInTheDocument();
    });
    expect(screen.getByText('拿铁')).toBeInTheDocument();
  });

  it('取消选中（再点同一 chip）时也收起上一轮选中的食物', async () => {
    pagesByCategory['蔬菜'] = [{ items: [makeHit(83, '西兰花', '蔬菜', 36)], total: 1, page: 1, pageSize: 20 }];

    renderComposer();
    await openCategoryTab();
    await pickCategory('蔬菜');

    await waitFor(() => {
      expect(screen.getByText('西兰花')).toBeInTheDocument();
    });

    await userEvent.setup().click(screen.getByRole('button', { name: /西兰花/ }));
    await waitFor(() => {
      expect(screen.getByText(/预估/)).toBeInTheDocument();
    });

    // 再点同一个 chip = 取消选中 → 列表与份量确认区一起消失，回到引导语
    await pickCategory('蔬菜');

    await waitFor(() => {
      expect(screen.queryByText(/预估/)).not.toBeInTheDocument();
    });
    expect(screen.queryByText('西兰花')).not.toBeInTheDocument();
    expect(screen.getByText(COPY.foodCategoryPrompt)).toBeInTheDocument();
  });

  it('分类查询与搜索查询不串数据：分类结果不会出现在搜索里，反之亦然', async () => {
    pagesByCategory['水果'] = [{ items: [makeHit(91, '苹果', '水果', 53)], total: 1, page: 1, pageSize: 20 }];

    renderComposer();
    await openCategoryTab();
    await pickCategory('水果');

    await waitFor(() => {
      expect(screen.getByText('苹果')).toBeInTheDocument();
    });

    // 切到搜索 tab，输入关键词 → 搜索结果里不应出现分类页的结果
    const user = userEvent.setup();
    const searchTab = screen.getByRole('tab', { name: '搜索' });
    searchTab.focus();
    await user.keyboard('{Enter}');

    // stub 里只在 `category=水果` 时返回苹果；搜索请求无 category，故应返回空页
    await user.click(screen.getByLabelText('搜索食物'));
    await user.keyboard('拿铁');

    await waitFor(() => {
      expect(searchUrls.some((url) => paramsOf(url).get('page') !== null)).toBe(true);
    });
    // 苹果是「分类页」的数据，搜索页不该出现（键若撞车，这里就会读到分类的缓存）
    expect(screen.queryByText('苹果')).not.toBeInTheDocument();
    const searchOnly = searchUrls.filter((url) => paramsOf(url).get('category') === null);
    expect(searchOnly.length).toBeGreaterThan(0);
    for (const url of searchOnly) {
      // 逐字输入会按每次关键词变化各发一次请求（正常行为），故只要求「最终那次」是完整词
      expect(paramsOf(searchOnly[searchOnly.length - 1] as string).get('q')).toBe('拿铁');
    }
    // 分类查询的缓存键（第三段 sentinel）与搜索查询的键必须互不相同
    const categoryKeyUrls = searchUrls.filter((url) => paramsOf(url).get('category') === '水果');
    expect(categoryKeyUrls.length).toBeGreaterThan(0);
    expect(paramsOf(categoryKeyUrls[0] as string).get('page')).toBe('1');
  });

  it('分类列表本身为空（`[]`）→ 渲染可行的下一步空态，且不显示「挑一个分类」引导', async () => {
    categoriesPayload = [];

    renderComposer();
    await openCategoryTabEmpty();

    // ① 空态文案在
    expect(screen.getByText(COPY.foodCategoryListEmpty)).toBeInTheDocument();
    // ② 不能一边说「挑一个」一边一个 chip 都没有
    expect(screen.queryByText(COPY.foodCategoryPrompt)).not.toBeInTheDocument();
    // ③ 没有 chip、没有报错卡，也不请求 /foods/search
    expect(screen.queryAllByRole('button', { name: /^分类：/ })).toHaveLength(0);
    expect(searchUrls).toEqual([]);

    // 文案红线照旧扫描
    for (const banned of ['推荐', '更健康', '低卡', '低热量', '评分', '等级', '过量']) {
      expect(screen.getByRole('dialog').textContent ?? '').not.toContain(banned);
    }
  });

  it('chip 不再出现英文 `other`，而是显示「其他」（读屏与视觉同一个词）', async () => {
    renderComposer();
    await openCategoryTab();

    const chips = screen.getAllByRole('button', { name: /^分类：/ });
    const texts = chips.map((chip) => chip.textContent ?? '');

    // 可见文字里没有裸的英文 `other`
    expect(texts.some((text) => text.includes('other'))).toBe(false);
    // 取而代之的是展示名（从 core 的 label 表取值，不写死字面量）
    expect(screen.getByRole('button', { name: chipAriaName('other') })).toBeInTheDocument();
    expect(texts.some((text) => text.endsWith(foodCategoryLabel('other')))).toBe(true);
    // 读屏标签同样用展示名（不出现 `分类：other`）
    expect(screen.queryByRole('button', { name: '分类：other' })).not.toBeInTheDocument();
    // 8 个中文类的展示名与枚举值相同，不受本次改动影响
    for (const category of FOOD_CATEGORIES) {
      if (category === 'other') continue;
      expect(texts.some((text) => text.endsWith(category))).toBe(true);
    }
  });

  it('选中「其他」后食物行显示「其他 · 每 100g」，不是「other · 每 100g」', async () => {
    pagesByCategory['other'] = [{ items: [makeHit(101, '大豆油', 'other', 899)], total: 1, page: 1, pageSize: 20 }];

    renderComposer();
    await openCategoryTab();
    await pickCategory('other');

    await waitFor(() => {
      expect(screen.getByText('大豆油')).toBeInTheDocument();
    });

    const row = screen.getByRole('button', { name: /大豆油/ });
    expect(row.textContent).toContain(`${foodCategoryLabel('other')} · 每 100g`);
    expect(row.textContent).not.toContain('other ·');
  });

  it('分类下没有条目 → 中性空态文案（不是空白，也不说「失败」）', async () => {
    pagesByCategory['other'] = [{ items: [], total: 0, page: 1, pageSize: 20 }];

    renderComposer();
    await openCategoryTab();
    await pickCategory('other');

    await waitFor(() => {
      expect(screen.getByText(COPY.foodCategoryEmpty)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
  });

  it('文案中性：分类面板不出现「推荐 / 更健康 / 低卡 / 评分 / 等级 / 过量」', async () => {
    pagesByCategory['主食'] = [
      { items: [makeHit(61, '米饭', '主食', 116), makeHit(62, '面条', '主食', 137)], total: 2, page: 1, pageSize: 20 },
    ];

    renderComposer();
    await openCategoryTab();
    await pickCategory('主食');

    await waitFor(() => {
      expect(screen.getByText('米饭')).toBeInTheDocument();
    });

    const panel = screen.getByRole('dialog');
    for (const banned of ['推荐', '更健康', '低卡', '低热量', '评分', '等级', '过量']) {
      expect(panel.textContent ?? '').not.toContain(banned);
    }
  });

  it('选中分类 → 切到「搜索」再切回来，不报错且选中态仍在', async () => {
    pagesByCategory['蛋白'] = [{ items: [makeHit(71, '鸡蛋', '蛋白', 144)], total: 1, page: 1, pageSize: 20 }];
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args[0]);
    });

    renderComposer();
    await openCategoryTab();
    await pickCategory('蛋白');

    await waitFor(() => {
      expect(screen.getByText('鸡蛋')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const searchTab = screen.getByRole('tab', { name: '搜索' });
    searchTab.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByLabelText('搜索食物')).toBeInTheDocument();
    });

    const categoryTab = screen.getByRole('tab', { name: COPY.foodCategoryTab });
    categoryTab.focus();
    await user.keyboard('{Enter}');

    // 切回来仍然可用（选中态保留在状态里，chip 行与列表都正常）
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '分类：蛋白' })).toBeInTheDocument();
    });
    expect(screen.getByText('鸡蛋')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '分类：蛋白' })).toHaveAttribute('aria-pressed', 'true');

    spy.mockRestore();
    // 状态切换过程中的 React 运行时错误（无效更新 / 卸载后 setState）不该出现
    expect(errors).toEqual([]);
  });

  it('分类浏览不触发在线兜底（`/foods/live-search`）——「库里有什么」不该混进 OFF 结果', async () => {
    const fetchMock = stubFetch();
    pagesByCategory['other'] = [{ items: [], total: 0, page: 1, pageSize: 20 }];

    renderComposer();
    await openCategoryTab();
    await pickCategory('other');

    await waitFor(() => {
      expect(screen.getByText(COPY.foodCategoryEmpty)).toBeInTheDocument();
    });

    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.some((url) => url.includes('/foods/live-search'))).toBe(false);
    expect(within(screen.getByRole('dialog')).queryByText(/在线结果/)).not.toBeInTheDocument();
  });
});
