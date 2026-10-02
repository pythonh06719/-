/**
 * 收藏「可加可取消」接线测试（pages/diary/MealComposer.tsx / GAP-1）。
 *
 * 背景：后端 `POST /foods/:id/favorite` / `DELETE /foods/:id/favorite` 早已就绪且幂等，
 * 但前端**只有读、没有任何写入口**，收藏夹永远是空的。本用例钉死写入口真的接上了：
 *
 * ① 未收藏时点星号 → 调 `POST /foods/:id/favorite`（**method + path + id 三者都要对**）；
 * ② 已收藏时点星号 → 调 `DELETE /foods/:id/favorite`；
 * ③ 点星号**不会**触发食物选择（不弹出份量确认区、不提交任何记录）；
 * ④ 写失败 → 给出温和提示（无负罪感）且状态**回滚**（`invalidateQueries` 回真值）；
 * ⑤ 收藏 tab 空态文案正确（引导用户去哪加藏，不说教）；
 * ⑥ 可访问性：星号带 `aria-pressed` + `aria-label`（含食物名，读屏能分辨是哪一条）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodItem } from '@qsh/shared-types';
import MealComposer from '@/pages/diary/MealComposer';
import type { ComposerSubmit } from '@/pages/diary/MealComposer';
import { COPY } from '@/lib/copy';

const TODAY = '2026-09-12';

/** 造一个食物库条目（字段与 `FoodItem` 契约一致）。 */
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

/** 收藏 tab 的初始数据（`GET /foods/favorites`）。 */
let favoriteItems: FoodItem[] = [];

/** 最近 tab 的初始数据（`GET /foods/recent`）——用来在「非收藏 tab」里验证星号也能加藏。 */
let recentItems: FoodItem[] = [];

/** 强制收藏写请求失败（验证回滚 + 温和提示）。 */
let failFavoriteWrite = false;

/** 记录所有写请求（method + url），供断言用。 */
interface RecordedRequest {
  method: string;
  url: string;
}
let writeRequests: RecordedRequest[] = [];

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = input;
      const method = init?.method ?? 'GET';

      // 收藏写端点：`POST` / `DELETE /foods/:id/favorite`
      if (/\/foods\/\d+\/favorite$/.test(url) && method !== 'GET') {
        writeRequests.push({ method, url });
        if (failFavoriteWrite) {
          return { ok: false, status: 500, json: async () => ({ data: null, error: { code: 'E_BOOM', message: '' } }) };
        }
        return ok({ favorited: method === 'POST' });
      }

      if (url.includes('/foods/favorites')) {
        return ok(favoriteItems);
      }
      if (url.includes('/foods/recent')) {
        return ok(recentItems);
      }
      return ok([]);
    }),
  );
}

let submitSpy: ReturnType<typeof vi.fn>;
let client: QueryClient;

function renderComposer(): void {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  submitSpy = vi.fn(async (_payload: ComposerSubmit): Promise<void> => undefined);
  render(
    <QueryClientProvider client={client}>
      <MealComposer date={TODAY} mealType="lunch" onClose={() => undefined} onSubmit={submitSpy} />
    </QueryClientProvider>,
  );
}

/** 切到某个 tab。 */
async function openTab(name: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('tab', { name })).toBeInTheDocument();
  });
  fireEvent.click(screen.getByRole('tab', { name }));
}

beforeEach(() => {
  favoriteItems = [];
  recentItems = [];
  failFavoriteWrite = false;
  writeRequests = [];
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GAP-1 收藏可加可取消', () => {
  it('未收藏时点星号 → POST /foods/:id/favorite（method + path + id 都对）', async () => {
    recentItems = [makeFood(7, '全脂牛奶')];
    renderComposer();
    await openTab('最近');

    const star = await screen.findByRole('button', { name: '收藏 全脂牛奶' });
    expect(star).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(star);

    await waitFor(() => {
      expect(writeRequests).toEqual([{ method: 'POST', url: expect.stringContaining('/foods/7/favorite') }]);
    });
    // 状态就地翻成「已收藏」，无需重新拉取
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '取消收藏 全脂牛奶' })).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('已收藏时点星号 → DELETE /foods/:id/favorite', async () => {
    favoriteItems = [makeFood(9, '番茄炒蛋')];
    renderComposer();
    await openTab('收藏');

    const star = await screen.findByRole('button', { name: '取消收藏 番茄炒蛋' });
    expect(star).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(star);

    await waitFor(() => {
      expect(writeRequests).toEqual([{ method: 'DELETE', url: expect.stringContaining('/foods/9/favorite') }]);
    });
    // 取消后该条**从收藏 tab 的列表里移除**（状态就地更新，无需重拉），列表回到空态
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '取消收藏 番茄炒蛋' })).not.toBeInTheDocument();
    });
    expect(screen.getByText(COPY.favoriteEmpty)).toBeInTheDocument();
  });

  it('点星号不会触发食物选择（不弹份量确认、不提交记录）', async () => {
    recentItems = [makeFood(3, '米饭')];
    renderComposer();
    await openTab('最近');

    const star = await screen.findByRole('button', { name: '收藏 米饭' });
    fireEvent.click(star);

    await waitFor(() => {
      expect(writeRequests.length).toBe(1);
    });
    // 没有进入份量确认流程
    expect(screen.queryByLabelText('选择份量')).not.toBeInTheDocument();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('写失败 → 温和提示 + 状态回滚', async () => {
    recentItems = [makeFood(5, '苹果')];
    failFavoriteWrite = true;
    renderComposer();
    await openTab('最近');

    const star = await screen.findByRole('button', { name: '收藏 苹果' });
    fireEvent.click(star);

    // 温和提示文案（无负罪感）
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(COPY.favoriteFailed);
    });
    // 回滚：仍然是「未收藏」
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '收藏 苹果' })).toHaveAttribute('aria-pressed', 'false');
    });
  });

  it('收藏 tab 空态文案正确（引导去哪加藏，不说教）', async () => {
    renderComposer();
    await openTab('收藏');

    await waitFor(() => {
      expect(screen.getByText(COPY.favoriteEmpty)).toBeInTheDocument();
    });
    expect(screen.getByText(COPY.favoriteEmpty)).toHaveTextContent('星号');
  });

  it('可访问性：星号带 aria-pressed 与含食物名的 aria-label（读屏可分辨是哪一条）', async () => {
    favoriteItems = [makeFood(1, '全脂牛奶'), makeFood(2, '脱脂牛奶')];
    renderComposer();
    await openTab('收藏');

    const milk = await screen.findByRole('button', { name: '取消收藏 全脂牛奶' });
    const skim = screen.getByRole('button', { name: '取消收藏 脱脂牛奶' });
    expect(milk).toHaveAttribute('aria-pressed', 'true');
    expect(skim).toHaveAttribute('aria-pressed', 'true');

    // 两个星号的名字不同 —— 读屏能区分「第几个 / 哪个食物」
    expect(milk.getAttribute('aria-label')).not.toBe(skim.getAttribute('aria-label'));

    // 星号是行内独立控件，不与「选食物」按钮互相嵌套。
    //
    // ⚠️ D-5 之后同一行有**三个**平级按钮（选食物 / 历史 / 星号），故这里的计数由 2 改为 3。
    // 这**不是**把断言放宽 —— 数字仍是**精确相等**（不是 `>= 2`），且下面补的那条
    // 「三者父节点相同、互不嵌套」才是这条用例真正要守的红线（嵌套 button 是非法 HTML）。
    // 元素个数从来不是红线，红线是「谁套着谁」。
    const row = milk.closest('li') as HTMLElement;
    expect(within(row).getAllByRole('button')).toHaveLength(3);

    // 三个按钮互为**平级兄弟**（同一个父节点），且互不嵌套
    const selectButton = within(row).getByText('全脂牛奶').closest('button') as HTMLElement;
    const historyButton = within(row).getByRole('button', { name: /全脂牛奶.*(什么时候吃过|的历史)/ });
    expect(milk.parentElement).toBe(selectButton.parentElement);
    expect(historyButton.parentElement).toBe(selectButton.parentElement);
    expect(selectButton.contains(milk)).toBe(false);
    expect(milk.querySelectorAll('button')).toHaveLength(0);
  });
});
