/**
 * 常吃榜（R11.5）接线测试（pages/diary/MealComposer.tsx）。
 *
 * 钉死五件事：
 * ① 「常吃」tab 位置在「最近」之后；点击行为与既有 `recent` / `favorite`
 *    **完全一致** —— 先进「份量确认」、再点「确认记录」（跳过份量会让热量失真，硬红线）；
 * ② 搜索**空态**顶部置顶「你常吃的」Top 5，位置在「没有找到这条食物」**之前**；
 *    有搜索结果时该区块**完全不渲染**；
 * ③ 列表项**只有名称 + 天数**：无热量、无三大营养素、无 `role="meter"`（AC-11.5.3 / 11.5.4）；
 * ④ 数据不足（< 3 天）→ 整块隐藏，**不留空卡、不给引导语**（AC-11.5.2）；
 * ⑤ 只呈现频次：**零营养评判**（AC-11.5.3 的禁用词清单做成正则断言）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodItem, SearchFoodsResponse, TopFoodItem, TopFoodsResponse } from '@qsh/shared-types';
import MealComposer from '@/pages/diary/MealComposer';
import type { ComposerSubmit } from '@/pages/diary/MealComposer';
import { COPY } from '@/lib/copy';

const TODAY = '2026-09-12';

/** 造一个食物库条目（供 `chooseFood` → 份量确认路径使用；字段与契约一致）。 */
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

/** 造一条常吃榜条目（`lastLoggedDate` 与契约一致：`YYYY-MM-DD`）。 */
function makeTopItem(
  name: string,
  dayCount: number,
  food: FoodItem | null,
  lastLoggedDate = '2026-09-08',
): TopFoodItem {
  return { name, dayCount, foodItemId: food === null ? null : food.id, food, lastLoggedDate };
}

/** 常吃榜响应（3 条可点 + 1 条快加条目 `food: null`）。 */
function topResponse(items: TopFoodItem[] = []): TopFoodsResponse {
  return { days: 90, items };
}

/** 搜索结果（默认：空）。 */
let searchItems: FoodItem[] = [];

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

let topItems: TopFoodItem[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/foods/top')) {
        return ok(topResponse(topItems));
      }
      if (url.includes('/foods/live-search')) {
        return ok({ items: [], found: 0, skipped: 0, degraded: false, source: 'openfoodfacts', license: 'ODbL 1.0' });
      }
      if (url.includes('/foods?') || url.includes('/api/foods')) {
        const response: SearchFoodsResponse = { items: searchItems, total: searchItems.length, page: 1, pageSize: 20 };
        return ok(response);
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

/** 切到「常吃」tab（先等榜单加载完成 → tab 才出现）。 */
async function openTopTab(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('tab', { name: COPY.topFoodsTab })).toBeInTheDocument();
  });
  fireEvent.click(screen.getByRole('tab', { name: COPY.topFoodsTab }));
  await waitFor(() => {
    expect(screen.getByText('番茄炒蛋')).toBeInTheDocument();
  });
}

beforeEach(() => {
  searchItems = [];
  topItems = [
    makeTopItem('番茄炒蛋', 12, makeFood(1, '番茄炒蛋'), '2026-09-08'),
    makeTopItem('米饭', 9, makeFood(2, '米饭'), '2026-09-10'),
    makeTopItem('奶茶', 5, makeFood(3, '奶茶'), '2026-09-05'),
    // 快加条目无法反查份量 → 只展示、不可点（Q-4）
    makeTopItem('楼下麻辣烫', 4, null),
  ];
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('R11.5 常吃榜 tab（AC-11.5.5）', () => {
  it('tab 位于「最近」之后', async () => {
    renderComposer();
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: COPY.topFoodsTab })).toBeInTheDocument();
    });
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs.indexOf('最近')).toBeLessThan(tabs.indexOf(COPY.topFoodsTab));
  });

  /**
   * ⚠️ 这条用例的标题曾写作「列表项**只有**名称 + 天数」。加入「上次是 X 月 X 日」后，
   * 字面上的「只有」已不成立 —— 但它**真正守的红线**是「无营养字段、无 `role="meter"`」，
   * 元素个数从来不是红线（AC-11.5.3 / 11.5.4 说的是「不出现什么」，不是「只能有两个」）。
   *
   * 故此处只把标题改成与实际断言一致的说法，`kcal` / `meter` / aria 陈述句
   * 三条断言**一个不减、一个不放宽**（不为让测试变绿而弱化红线）。
   */
  it('列表项无营养字段、无 role="meter"（日期这类频次事实不在此限）', async () => {
    renderComposer();
    await openTopTab();

    expect(screen.getByText('番茄炒蛋')).toBeInTheDocument();
    expect(screen.getByText('12 天')).toBeInTheDocument();
    expect(screen.getByText('9 天')).toBeInTheDocument();

    // 快加条目不渲染为可点按钮（Q-4）
    expect(screen.queryByText('楼下麻辣烫')).not.toBeInTheDocument();

    // 没有任何营养数值 / 进度条
    expect(screen.queryByText(/kcal/)).not.toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();

    // 无障碍标签是「频次」陈述句，不是评价
    expect(screen.getByLabelText('近 90 天里，番茄炒蛋出现了 12 天')).toBeInTheDocument();
  });

  it('点击走既有 chooseFood 路径：先进份量确认、再确认记录（不跳过份量）', async () => {
    renderComposer();
    await openTopTab();

    fireEvent.click(screen.getByLabelText('近 90 天里，番茄炒蛋出现了 12 天'));

    // 出现了「选择份量」区块，但**还没有提交**
    await waitFor(() => {
      expect(screen.getByLabelText('选择份量')).toBeInTheDocument();
    });
    expect(submitSpy).not.toHaveBeenCalled();

    // 再点「确认记录」才提交 —— 与 recent / favorite 完全一致
    fireEvent.click(screen.getByRole('button', { name: '确认记录' }));
    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledTimes(1);
    });
    const payload = submitSpy.mock.calls[0]?.[0] as ComposerSubmit;
    expect(payload.kind).toBe('food');
  });

  it('数据不足（items 为空）→ 整块隐藏，不留空卡、不给引导语', async () => {
    topItems = [];
    renderComposer();
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '搜索' })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: COPY.topFoodsTab })).not.toBeInTheDocument();
    });
    expect(screen.queryByText(COPY.topFoodsTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(/还没有常吃|还没有记录过食物以外/)).not.toBeInTheDocument();
  });
});

describe('R11.5+ 常吃榜「上次食用日期」透传（core 已算好，UI 只接线）', () => {
  it('★ 每行都显示「上次是 X 月 X 日」（复用 formatMonthDay 的既有格式）', async () => {
    renderComposer();
    await openTopTab();

    // 契约给的 `lastLoggedDate` 是 `YYYY-MM-DD`，界面上是「9月8日」这种本地写法
    expect(screen.getByText('上次是 9月8日')).toBeInTheDocument();
    expect(screen.getByText('上次是 9月10日')).toBeInTheDocument();
    expect(screen.getByText('上次是 9月5日')).toBeInTheDocument();
  });

  it('★ 显示的是接口给的那一天（纯透传，UI 不另算「隔了几天」）', async () => {
    topItems = [makeTopItem('番茄炒蛋', 12, makeFood(1, '番茄炒蛋'), '2026-09-08')];
    renderComposer();
    await openTopTab();

    expect(screen.getByText('上次是 9月8日')).toBeInTheDocument();
    // 「隔了多少天」这类衍生数字一律不出现（QD-6 / 健康暗示红线）
    expect(screen.queryByText(/隔了|已经\s*\d+\s*天没|没吃/)).not.toBeInTheDocument();
  });

  it('★ 日期行不是独立控件：行内仍是**一个**按钮，没有嵌套 button', async () => {
    renderComposer();
    await openTopTab();

    const line = screen.getByText('上次是 9月8日');
    const button = line.closest('button');
    expect(button).not.toBeNull();
    // 整行按钮内部不能再套 button（嵌套 button 是非法 HTML，读屏会读乱）
    expect(button?.querySelectorAll('button')).toHaveLength(0);
    // 点击这一行仍走既有 chooseFood 路径（与日期小字无关）
    fireEvent.click(button as HTMLElement);
    await waitFor(() => {
      expect(screen.getByLabelText('选择份量')).toBeInTheDocument();
    });
  });

  it('★ 排序仍只按频次：加了日期后顺序不变（AC-11.5.4）', async () => {
    renderComposer();
    await openTopTab();

    const list = screen.getByText('上次是 9月8日').closest('ul') as HTMLElement;
    const html = list.innerHTML;
    // 接口顺序 12 天 → 9 天 → 5 天；日期（9-08 / 9-10 / 9-05）**不参与**排序
    expect(html.indexOf('番茄炒蛋')).toBeLessThan(html.indexOf('米饭'));
    expect(html.indexOf('米饭')).toBeLessThan(html.indexOf('奶茶'));
  });

  it('★ 红线：日期行无 role="meter"、无营养字段、无红/黄警示色', async () => {
    renderComposer();
    await openTopTab();

    expect(screen.queryByRole('meter')).not.toBeInTheDocument();

    const line = screen.getByText('上次是 9月8日');
    // 警示语义色（红 / 黄 / 橙）一律不得用于这一行（AC-11.5.3）
    expect(line.className).not.toMatch(/red|amber|yellow|orange/);

    const panelText = (screen.getByText('上次是 9月8日').closest('ul') as HTMLElement).textContent ?? '';
    for (const word of ['kcal', '千卡', '蛋白', '脂肪', '碳水', '热量']) {
      expect(panelText).not.toContain(word);
    }
  });

  it('日期缺失 / 非法 → 整句不渲染（不猜日期、不写「未知」）', async () => {
    topItems = [
      makeTopItem('番茄炒蛋', 12, makeFood(1, '番茄炒蛋'), ''),
      makeTopItem('米饭', 9, makeFood(2, '米饭'), 'not-a-date'),
    ];
    renderComposer();
    await openTopTab();

    expect(screen.getByText('番茄炒蛋')).toBeInTheDocument();
    expect(screen.queryByText(/上次是/)).not.toBeInTheDocument();
    // 不把「没有日期」写成一句让用户觉得缺了什么的话
    expect(screen.queryByText(/未知|暂无|没有记录/)).not.toBeInTheDocument();
  });
});

describe('R11.5 搜索空态置顶（AC-11.5.6）', () => {
  it('搜索无结果 → 顶部出现「你常吃的」Top 5，且位置在空态文案之前', async () => {
    renderComposer();
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: COPY.topFoodsTab })).toBeInTheDocument();
    });

    const input = screen.getByLabelText('搜索食物');
    fireEvent.change(input, { target: { value: '不存在的食物' } });

    await waitFor(() => {
      expect(screen.getByTestId('top-foods-empty-state')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('没有找到这条食物，试试「快加」')).toBeInTheDocument();
    });
    expect(screen.getByText(COPY.topFoodsTitle)).toBeInTheDocument();

    // 「你常吃的」标题必须排在空态文案之前
    const block = screen.getByTestId('top-foods-empty-state');
    const container = block.parentElement as HTMLElement;
    const html = container.innerHTML;
    expect(html.indexOf('你常吃的')).toBeLessThan(html.indexOf('没有找到这条食物'));

    // Top 5（去除了不可点的快加条目后剩 3 条）
    expect(screen.getByText('番茄炒蛋')).toBeInTheDocument();
    expect(screen.getByText('米饭')).toBeInTheDocument();
  });

  it('有搜索结果 → 该区块完全不渲染', async () => {
    searchItems = [makeFood(9, '番茄炒蛋')];
    renderComposer();

    const input = screen.getByLabelText('搜索食物');
    fireEvent.change(input, { target: { value: '番茄' } });

    await waitFor(() => {
      expect(screen.getAllByText('番茄炒蛋').length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId('top-foods-empty-state')).not.toBeInTheDocument();
    expect(screen.queryByText(COPY.topFoodsTitle)).not.toBeInTheDocument();
  });
});

describe('R11.5 零营养评判（AC-11.5.3 可 grep 校验）', () => {
  /** 禁用词：命中任一即判定不通过。 */
  const BANNED = [
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
    '健康度',
    '评分',
    '等级',
  ];

  it('常吃榜相关文案一个禁用词都不命中', async () => {
    renderComposer();
    await openTopTab();

    const text = [
      COPY.topFoodsTab,
      COPY.topFoodsTitle,
      screen.getByLabelText('近 90 天里，番茄炒蛋出现了 12 天').getAttribute('aria-label') ?? '',
      screen.getByText('12 天').textContent ?? '',
      // 新增的「上次食用日期」也必须在同一份黑名单之下
      screen.getByText('上次是 9月8日').textContent ?? '',
    ].join(' ');

    for (const word of BANNED) {
      expect(text).not.toContain(word);
    }
    // 健康暗示句式（不只是单个禁用词）：日期行不得变成「你已经 N 天没吃 X 了」
    expect(text).not.toMatch(/已经\s*\d+\s*天没|隔了\s*\d+\s*天|吃得(有点)?频繁/);
  });
});
