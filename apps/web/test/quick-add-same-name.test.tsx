/**
 * 快速加卡「同名温和提示」（C1）接线测试。
 *
 * 背景：食物库扩到数百条（现 443 条）后，用户手填「番茄炒蛋」时库里大概率已经有了 ——
 * 静默创建会造成三个后果：个人库被重复数据污染、手填热量往往不如库内准确、
 * 常吃榜与多样性计数出现「同物两名」被稀释。
 *
 * 本测试要钉死的是**这个提示的边界**，重点是它**不是**一个纠正/拦截机制：
 * ① 只在**同名**（或去空白后同名）时出现，近名/子串命中**不出现**（防「提示轰炸」）；
 * ② 措辞是**提供选择**，不出现「你填错了 / 检测到重复 / 建议」这类判定式说法；
 * ③ **不阻断**提交：「继续用我填的」之后照常能记，G1「3 次点击记一餐」不受影响；
 * ④ 「用库里的」把名称与热量填成库内值；
 * ⑤ 换了名字后重新判定，不沿用上一次的跳过表态。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FoodItem, FoodSearchHit, FoodSearchResponse } from '@qsh/shared-types';
import MealComposer from '@/pages/diary/MealComposer';

function makeHit(
  id: number,
  name: string,
  matchRank: 0 | 1 | 2 = 0,
  kcalPer100g = 100,
): FoodSearchHit {
  const food: FoodItem = {
    id,
    name,
    namePinyin: null,
    aliases: [],
    category: '家常菜',
    kcalPer100g,
    proteinGPer100g: 8,
    fatGPer100g: 6,
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
  return { ...food, qualifier: null, matchRank };
}

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

/** stub `fetch`：`/foods/search` 返回给定的命中列表，其余接口给空壳。 */
function stubFetch(items: FoodSearchHit[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/foods/search')) {
      const body: FoodSearchResponse = { items, total: items.length, page: 1, pageSize: 10 };
      return ok(body);
    }
    if (url.includes('/foods/top')) return ok({ items: [], days: 30 });
    if (url.includes('/foods/recent') || url.includes('/foods/favorites')) return ok([]);
    if (url.includes('/meal-combos')) return ok([]);
    return ok(null);
  });
}

function renderComposer(onSubmit = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MealComposer date="2026-09-27" mealType="lunch" onClose={vi.fn()} onSubmit={onSubmit} />
    </QueryClientProvider>,
  );
  return onSubmit;
}

/** 切到「快加」tab 并填名称 + 热量。 */
async function fillQuick(name: string, kcal = '600') {
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: '快加' }));
  const nameInput = screen.getByPlaceholderText('如：楼下麻辣烫');
  await user.clear(nameInput);
  await user.type(nameInput, name);
  const kcalInput = screen.getByPlaceholderText('如：600');
  await user.clear(kcalInput);
  await user.type(kcalInput, kcal);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('C1 快速加卡同名提示', () => {
  it('手填名与库里同名时，温和地问一句', async () => {
    vi.stubGlobal('fetch', stubFetch([makeHit(7, '番茄炒蛋', 0, 120)]));
    renderComposer();
    await fillQuick('番茄炒蛋');

    const notice = await screen.findByTestId('quick-same-name-notice');
    expect(notice.textContent).toContain('库里已经有「番茄炒蛋」了');
  });

  it('去空白后同名也算同名（用户多打了空格不该漏掉）', async () => {
    vi.stubGlobal('fetch', stubFetch([makeHit(7, '番茄炒蛋', 0, 120)]));
    renderComposer();
    await fillQuick('  番茄炒蛋  ');

    expect(await screen.findByTestId('quick-same-name-notice')).toBeTruthy();
  });

  it('只是子串/近名命中时**不**提示（防提示轰炸）', async () => {
    // 库里只有「番茄鸡蛋面」，用户填「番茄炒蛋」—— 名字并不相同
    vi.stubGlobal('fetch', stubFetch([makeHit(7, '番茄鸡蛋面', 1, 150)]));
    renderComposer();
    await fillQuick('番茄炒蛋');

    // 等搜索确实回来了（不同名 → 不该有提示）
    await waitFor(() => {
      expect(screen.queryByTestId('quick-same-name-notice')).toBeNull();
    });
  });

  it('措辞是提供选择，不是判定用户填错', async () => {
    vi.stubGlobal('fetch', stubFetch([makeHit(7, '番茄炒蛋', 0, 120)]));
    renderComposer();
    await fillQuick('番茄炒蛋');

    const notice = await screen.findByTestId('quick-same-name-notice');
    const text = notice.textContent ?? '';
    // 有「也可以继续用你填的」= 尊重用户选择
    expect(text).toContain('也可以继续用你填的');
    // 没有评判式说法
    for (const banned of ['你填错', '检测到重复', '建议改用', '重复项', '错误']) {
      expect(text).not.toContain(banned);
    }
  });

  it('「继续用我填的」后提示消失，且不阻断提交', async () => {
    vi.stubGlobal('fetch', stubFetch([makeHit(7, '番茄炒蛋', 0, 120)]));
    const onSubmit = renderComposer();
    await fillQuick('番茄炒蛋', '600');

    const notice = await screen.findByTestId('quick-same-name-notice');
    const user = userEvent.setup();
    await user.click(within(notice).getByRole('button', { name: '继续用我填的' }));
    await waitFor(() => {
      expect(screen.queryByTestId('quick-same-name-notice')).toBeNull();
    });

    // 照常能记：提交的是用户自己填的内容
    await user.click(screen.getByRole('button', { name: '确认记录' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ kind: 'quick', name: '番茄炒蛋', kcal: 600 });
    });
  });

  it('「用库里的」把名称与热量换成库内值', async () => {
    vi.stubGlobal('fetch', stubFetch([makeHit(7, '番茄炒蛋', 0, 128)]));
    renderComposer();
    await fillQuick('番茄炒蛋', '600');

    const notice = await screen.findByTestId('quick-same-name-notice');
    const user = userEvent.setup();
    await user.click(within(notice).getByRole('button', { name: /用库里的/ }));

    await waitFor(() => {
      expect((screen.getByPlaceholderText('如：楼下麻辣烫') as HTMLInputElement).value).toBe(
        '番茄炒蛋',
      );
      expect((screen.getByPlaceholderText('如：600') as HTMLInputElement).value).toBe('128');
    });
  });

  it('换了名字后重新判定，不沿用上一次的跳过表态', async () => {
    vi.stubGlobal('fetch', stubFetch([makeHit(7, '番茄炒蛋', 0, 120)]));
    renderComposer();
    await fillQuick('番茄炒蛋');

    const notice = await screen.findByTestId('quick-same-name-notice');
    const user = userEvent.setup();
    await user.click(within(notice).getByRole('button', { name: '继续用我填的' }));
    await waitFor(() => {
      expect(screen.queryByTestId('quick-same-name-notice')).toBeNull();
    });

    // 改一个字符 → 名字变了，应重新问一次（仍然同名）
    const nameInput = screen.getByPlaceholderText('如：楼下麻辣烫');
    await user.clear(nameInput);
    await user.type(nameInput, '番茄炒蛋');

    expect(await screen.findByTestId('quick-same-name-notice')).toBeTruthy();
  });

  it('库里没有同名时不提示，快加流程完全照旧', async () => {
    vi.stubGlobal('fetch', stubFetch([makeHit(7, '番茄鸡蛋面', 1, 150)]));
    const onSubmit = renderComposer();
    await fillQuick('楼下麻辣烫', '600');

    await waitFor(() => {
      expect(screen.queryByTestId('quick-same-name-notice')).toBeNull();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '确认记录' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ kind: 'quick', name: '楼下麻辣烫', kcal: 600 });
    });
  });
});
