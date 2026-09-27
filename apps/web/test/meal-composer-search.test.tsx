/**
 * 搜索排序 + 加载更多 接线测试（阶段 2.2 / 2.4 / 2.5）。
 *
 * 钉死五件事：
 * ① 搜索走 `GET /foods/search`，**按服务端返回顺序渲染**（前缀 > 子串 > 仅别名），
 *    前端不做任何二次排序（尤其不按热量/营养）；
 * ② 跨来源同物异名**不合并**：`蘑菇（鲜蘑）` / `蘑菇(干)` / `蘑菇（罐头）` 三条都在，
 *    各自带**区分词**标签（形态/口味/部位规格），标签是事实陈述、不是评价；
 * ③ `total` 被如实渲染（「共 N 条，已显示 M 条」）+「加载更多」按页累加、不跳条不重复；
 * ④ **键盘路径**：用 `userEvent.keyboard` 真实敲键输入 + 用 `{Enter}` 激活「加载更多」
 *    （此前 `apps/web/test` 里键盘交互用例为零命中 —— 这是拖拽那类「测试全绿但功能是坏的」
 *    同款盲区，故本轮必须补上）；
 * ⑤ 文案中性：无「推荐 / 更健康 / 低卡」这类变相营养建议词。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodItem, FoodSearchHit, FoodSearchResponse } from '@qsh/shared-types';
import MealComposer from '@/pages/diary/MealComposer';

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

/** 记录每次搜索请求的 URL（断言分页参数用）。 */
let requestedPages: number[] = [];

/** stub `fetch`：按 `page` 返回预置的分页响应。 */
function stubSearch(pages: FoodSearchResponse[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/foods/search')) {
      const parsed = new URL(url, 'http://localhost');
      const page = Number(parsed.searchParams.get('page') ?? '1');
      requestedPages.push(page);
      return ok(pages[page - 1] ?? { items: [], total: 0, page, pageSize: 20 });
    }
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

/** 渲染出的结果行（DOM 顺序 = 后端排序顺序）。 */
function resultRows(): string[] {
  return screen.getAllByRole('listitem').map((row) => row.textContent ?? '');
}

afterEach(() => {
  vi.unstubAllGlobals();
  requestedPages = [];
});

describe('搜索排序（阶段 2.2）：按服务端相关度顺序渲染，前端不重排', () => {
  it('前缀 > 子串 > 仅别名：顺序与后端返回一致，且三条各带区分词', async () => {
    stubSearch([
      {
        items: [
          makeHit(1, '蘑菇（鲜蘑）', '鲜蘑', 0, 24),
          makeHit(2, '蘑菇(干)', '干', 0, 295),
          makeHit(3, '蘑菇（罐头）', '罐头', 0, 22),
        ],
        total: 3,
        page: 1,
        pageSize: 20,
      },
    ]);

    renderComposer();
    fireEvent.change(screen.getByLabelText('搜索食物'), { target: { value: '蘑菇' } });

    await waitFor(() => {
      expect(resultRows()).toHaveLength(3);
    });

    const rows = resultRows();
    expect(rows[0]).toContain('蘑菇（鲜蘑）');
    expect(rows[1]).toContain('蘑菇(干)');
    expect(rows[2]).toContain('蘑菇（罐头）');

    // 区分词标签：三条**没有**被合并成一条「蘑菇」，各自的形态标注都在
    const items = screen.getAllByRole('listitem');
    expect(within(items[0] as HTMLElement).getByText('鲜蘑')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('干')).toBeInTheDocument();
    expect(within(items[2] as HTMLElement).getByText('罐头')).toBeInTheDocument();

    // 全部加载完（已显示 3 / 共 3）→ 不再出现「加载更多」
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
    expect(screen.getByText('共 3 条，已显示 3 条')).toBeInTheDocument();
  });

  it('顺序完全照搬后端（不按热量重排）：295 kcal 的「干」排第二而不是第一', async () => {
    stubSearch([
      {
        items: [makeHit(1, '青柠实验（鲜）', '鲜', 0, 12), makeHit(2, '青柠实验（干）', '干', 0, 320), makeHit(3, 'ZQ 饮品', '饮品', 2, 5)],
        total: 3,
        page: 1,
        pageSize: 20,
      },
    ]);

    renderComposer();
    fireEvent.change(screen.getByLabelText('搜索食物'), { target: { value: '青柠实验' } });

    await waitFor(() => {
      expect(resultRows()).toHaveLength(3);
    });

    const rows = resultRows();
    expect(rows[0]).toContain('青柠实验（鲜）');
    expect(rows[1]).toContain('青柠实验（干）');
    expect(rows[2]).toContain('ZQ 饮品');
  });

  it('文案中性：搜索区不出现「推荐 / 更健康 / 低卡」这类变相营养建议词', async () => {
    stubSearch([
      {
        items: [makeHit(1, '蘑菇(干)', '干', 0, 295)],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    ]);

    renderComposer();
    fireEvent.change(screen.getByLabelText('搜索食物'), { target: { value: '蘑菇' } });

    await waitFor(() => {
      expect(screen.getByText('共 1 条，已显示 1 条')).toBeInTheDocument();
    });

    const panel = screen.getByRole('dialog');
    for (const banned of ['推荐', '更健康', '低卡', '低热量', '评分', '等级']) {
      expect(panel.textContent ?? '').not.toContain(banned);
    }
  });

  it('关键词为空时不请求 `/foods/search`（空态不打无意义请求）', async () => {
    stubSearch([]);
    renderComposer();

    await waitFor(() => {
      expect(screen.getByLabelText('搜索食物')).toBeInTheDocument();
    });
    expect(requestedPages).toEqual([]);
  });
});

describe('加载更多（阶段 2.4）：按 total 稳定翻页、不重复', () => {
  /** 第 1 页 2 条、第 2 页 1 条，共 3 条。 */
  function threeAcrossTwoPages(): void {
    stubSearch([
      { items: [makeHit(1, '蘑菇（鲜蘑）', '鲜蘑', 0, 24), makeHit(2, '蘑菇(干)', '干', 0, 295)], total: 3, page: 1, pageSize: 2 },
      { items: [makeHit(3, '蘑菇（罐头）', '罐头', 0, 22)], total: 3, page: 2, pageSize: 2 },
    ]);
  }

  it('鼠标点击「加载更多」→ 追加下一页并如实更新已显示条数', async () => {
    threeAcrossTwoPages();
    renderComposer();
    fireEvent.change(screen.getByLabelText('搜索食物'), { target: { value: '蘑菇' } });

    await waitFor(() => {
      expect(screen.getByText('共 3 条，已显示 2 条')).toBeInTheDocument();
    });
    expect(resultRows()).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));

    await waitFor(() => {
      expect(resultRows()).toHaveLength(3);
    });
    expect(screen.getByText('共 3 条，已显示 3 条')).toBeInTheDocument();
    // 翻到第 2 页（`page` 参数），且第 1 页的条目仍在（累加而非替换）
    expect(requestedPages).toEqual([1, 2]);
    expect(resultRows()[0]).toContain('蘑菇（鲜蘑）');
    expect(resultRows()[2]).toContain('蘑菇（罐头）');
    // 全部加载完 → 按钮消失
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
  });

  it('⌨️ 键盘路径：真实敲键输入 → Tab 到「加载更多」→ Enter 激活（不依赖鼠标）', async () => {
    const user = userEvent.setup();
    threeAcrossTwoPages();
    renderComposer();

    const input = screen.getByLabelText('搜索食物');
    input.focus();
    // 真实键盘输入（逐键 keydown/keypress/input），不是 change 事件代劳
    await user.keyboard('蘑菇');

    await waitFor(() => {
      expect(screen.getByText('共 3 条，已显示 2 条')).toBeInTheDocument();
    });

    // 只把焦点放到按钮上并敲 Enter —— 若按钮的键盘激活路径坏了，本用例必须红
    const more = screen.getByRole('button', { name: '加载更多' });
    more.focus();
    expect(more).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(resultRows()).toHaveLength(3);
    });
    // 逐字输入会按每次关键词变化各请求一次第 1 页（正常行为），故只断言「第 2 页确实被请求过」
    expect(requestedPages).toContain(1);
    expect(requestedPages[requestedPages.length - 1]).toBe(2);
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
  });

  it('⌨️ 键盘路径：从输入框按 Tab 能走到「加载更多」（可聚焦、可到达）', async () => {
    const user = userEvent.setup();
    threeAcrossTwoPages();
    renderComposer();

    const input = screen.getByLabelText('搜索食物');
    input.focus();
    await user.keyboard('蘑菇');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '加载更多' })).toBeInTheDocument();
    });

    // 反复 Tab，直到焦点落到「加载更多」上（最多 30 次，防止无限循环）
    const more = screen.getByRole('button', { name: '加载更多' });
    for (let step = 0; step < 30 && document.activeElement !== more; step += 1) {
      await user.tab();
    }
    expect(more).toHaveFocus();
  });

  it('结果只有一页时不给「加载更多」（不留死按钮）', async () => {
    stubSearch([
      { items: [makeHit(1, '蘑菇(干)', '干', 0, 295)], total: 1, page: 1, pageSize: 20 },
    ]);
    renderComposer();
    fireEvent.change(screen.getByLabelText('搜索食物'), { target: { value: '蘑菇' } });

    await waitFor(() => {
      expect(screen.getByText('共 1 条，已显示 1 条')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
  });
});
