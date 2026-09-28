/**
 * GAP-2「一餐可以存成套餐」前端接线测试。
 *
 * 背景：后端 `POST /meal-combos` 三件套早就齐全，但前端**零调用** ——
 * 套餐 tab 永远只剩空态，应用链路（`applyCombo`）通了、源头却断了。
 * 本测试钉死这条新接上的链路：
 * ① 有记录的餐次显示「存成套餐」入口；**空餐次不显示**（空套餐是僵尸数据）；
 * ② 点入口 → 命名弹窗（默认名已填）→ 提交 → 请求体 `name` / `mealType` / `items` 形状全对，
 *    尤其自定义条目（`foodItemId=null`）**带 `customName` + `kcal`、不带 `foodId`**；
 * ③ 成功后调用了 `queryKeys.combos`（`['meal-combos']`）的失效刷新（套餐 tab 才看得到新套餐）；
 * ④ 409 同名 → 温和提示（用服务端 message）且**弹窗不关闭**，改名后能重提交；
 * ⑤ 离线 → 诚实告知、**没有**走 `enqueueRequest`（不入离线队列，避免 409 永久堵队列）；
 * ⑥ 🔴 无负罪感：全程不出现「失败 / 错误 / 超标」这类评判式字样。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ListMealsResponse, MealLog, MealType } from '@qsh/shared-types';
import DiaryPage from '@/pages/diary/DiaryPage';
import { formatMonthDay, todayKey } from '@/lib/format';
import { cacheClearAll } from '@/lib/local-cache';
import * as offlineQueue from '@/pwa/offline-queue';

const TODAY = todayKey();
const MONTH_DAY = formatMonthDay(TODAY);

/** 建一条 `MealLog`（`foodItemId` 非空 = 食物库条目；为空 = 快速加卡条目）。 */
function makeLog(input: {
  id: number;
  name: string;
  foodItemId: number | null;
  kcal: number;
  grams?: number | null;
  mealType?: MealType;
}): MealLog {
  return {
    id: input.id,
    userId: 1,
    loggedDate: TODAY,
    mealType: input.mealType ?? 'breakfast',
    foodItemId: input.foodItemId,
    customName: input.name,
    grams: input.grams ?? null,
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
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  };
}

function mealsResponse(logs: MealLog[]): ListMealsResponse {
  const byType = (type: MealType): MealLog[] => logs.filter((log) => log.mealType === type);
  return {
    date: TODAY,
    groups: (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).map((mealType) => {
      const groupLogs = byType(mealType);
      return { mealType, logs: groupLogs, totalKcal: groupLogs.reduce((sum, log) => sum + log.kcal, 0) };
    }),
    totalKcal: logs.reduce((sum, log) => sum + log.kcal, 0),
  };
}

function ok(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

/** 捕获到的 `POST /meal-combos` 请求体。 */
let posted: unknown[] = [];
/** 让 POST /meal-combos 返回指定错误（模拟 409 同名）。 */
let comboPostError: { status: number; code: string; message: string } | null = null;
/** 让所有 fetch 抖动成网络层异常（模拟离线）。 */
let simulateOffline = false;

function stubFetch(logs: MealLog[]): void {
  posted = [];
  comboPostError = null;
  simulateOffline = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (simulateOffline) {
        throw new TypeError('Failed to fetch');
      }
      const method = init?.method ?? 'GET';
      if (url.includes('/meal-combos') && method === 'POST') {
        posted.push(init?.body === undefined ? undefined : JSON.parse(init.body));
        if (comboPostError !== null) {
          return {
            ok: false,
            status: comboPostError.status,
            json: async () => ({
              data: null,
              error: { code: comboPostError?.code, message: comboPostError?.message },
            }),
          };
        }
        const body = JSON.parse(init?.body ?? '{}') as { name: string; mealType: MealType };
        return ok({ id: 99, name: body.name, mealType: body.mealType, items: [] });
      }
      if (url.includes('/meals')) {
        return ok(mealsResponse(logs));
      }
      if (url.includes('/weights')) {
        return ok({ points: [], movingAverage7: [], stats: {}, forecast: [], goalProgress: null });
      }
      return ok([]);
    }),
  );
}

function renderDiary(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DiaryPage initialDate={TODAY} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  cacheClearAll();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GAP-2 存成套餐 · 入口是否出现', () => {
  it('有记录的餐次显示入口；空餐次不显示', async () => {
    const log = makeLog({ id: 1, name: '全脂牛奶', foodItemId: 42, kcal: 134, mealType: 'breakfast' });
    stubFetch([log]);
    renderDiary();

    // 早餐有记录 → 有入口
    expect(await screen.findByTestId('save-combo-breakfast')).toBeInTheDocument();
    // 午餐 / 晚餐 / 加餐都空 → 都没有入口（空餐存成套餐没有意义）
    expect(screen.queryByTestId('save-combo-lunch')).not.toBeInTheDocument();
    expect(screen.queryByTestId('save-combo-dinner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('save-combo-snack')).not.toBeInTheDocument();
  });
});

describe('GAP-2 存成套餐 · 提交请求形状', () => {
  it('库内 + 自定义混合的一餐：name / mealType / items 全对，自定义条目带 customName+kcal 且不带 foodId', async () => {
    const logs = [
      makeLog({ id: 1, name: '全脂牛奶', foodItemId: 42, kcal: 134, grams: 250, mealType: 'breakfast' }),
      makeLog({ id: 2, name: '楼下豆浆', foodItemId: null, kcal: 90, grams: 300, mealType: 'breakfast' }),
    ];
    stubFetch(logs);
    renderDiary();

    fireEvent.click(await screen.findByTestId('save-combo-breakfast'));

    // 弹窗出现，默认名已填（餐次 + 月日）
    const dialog = await screen.findByRole('dialog', { name: '给这一餐起个名字' });
    const nameInput = within(dialog).getByLabelText('套餐名字') as HTMLInputElement;
    expect(nameInput.value).toBe(`早餐（${MONTH_DAY}）`);

    // 改名后提交
    fireEvent.change(nameInput, { target: { value: '我的常规早餐' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '存下来' }));

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    const body = posted[0] as { name: string; mealType: string; items: Array<Record<string, unknown>> };
    expect(body.name).toBe('我的常规早餐');
    expect(body.mealType).toBe('breakfast');
    expect(body.items).toHaveLength(2);

    // 库内条目：带 foodId
    expect(body.items[0]).toMatchObject({
      sortOrder: 0,
      foodId: 42,
      customName: '全脂牛奶',
      kcal: 134,
      grams: 250,
    });

    // 自定义条目：带 customName + kcal，**不带 foodId**
    expect(body.items[1]).not.toHaveProperty('foodId');
    expect(body.items[1]).toMatchObject({ sortOrder: 1, customName: '楼下豆浆', kcal: 90, grams: 300 });
  });

  it('名称为空 → 中性提示且不发请求', async () => {
    const log = makeLog({ id: 1, name: '全脂牛奶', foodItemId: 42, kcal: 134, mealType: 'breakfast' });
    stubFetch([log]);
    renderDiary();

    fireEvent.click(await screen.findByTestId('save-combo-breakfast'));
    const dialog = await screen.findByRole('dialog', { name: '给这一餐起个名字' });

    fireEvent.change(within(dialog).getByLabelText('套餐名字'), { target: { value: '   ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '存下来' }));

    expect(await within(dialog).findByText('填个名字就能存下来了')).toBeInTheDocument();
    expect(posted).toHaveLength(0);
  });
});

describe('GAP-2 存成套餐 · 成功后刷新套餐列表', () => {
  it('提交成功 → invalidateQueries([\'meal-combos\']) 被调用', async () => {
    const log = makeLog({ id: 1, name: '全脂牛奶', foodItemId: 42, kcal: 134, mealType: 'breakfast' });
    stubFetch([log]);
    const client = renderDiary();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    fireEvent.click(await screen.findByTestId('save-combo-breakfast'));
    const dialog = await screen.findByRole('dialog', { name: '给这一餐起个名字' });
    fireEvent.click(within(dialog).getByRole('button', { name: '存下来' }));

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['meal-combos'] });
    });
    // 成功后弹窗关闭 + 正向播报
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '给这一餐起个名字' })).not.toBeInTheDocument();
    });
  });
});

describe('GAP-2 存成套餐 · 409 同名', () => {
  it('同名 409 → 温和提示、弹窗不关、改名后可重提交', async () => {
    const log = makeLog({ id: 1, name: '全脂牛奶', foodItemId: 42, kcal: 134, mealType: 'breakfast' });
    stubFetch([log]);
    renderDiary();

    fireEvent.click(await screen.findByTestId('save-combo-breakfast'));
    const dialog = await screen.findByRole('dialog', { name: '给这一餐起个名字' });

    // 第一次提交 → 后端 409 同名
    comboPostError = {
      status: 409,
      code: 'VALID_DUPLICATE',
      message: '已经有一个同名套餐了，换个名字试试',
    };
    fireEvent.click(within(dialog).getByRole('button', { name: '存下来' }));

    const notice = await within(dialog).findByTestId('save-combo-notice');
    expect(notice.textContent).toContain('已经有一个同名套餐了，换个名字试试');
    // 弹窗没关，用户可改名重试
    expect(screen.getByRole('dialog', { name: '给这一餐起个名字' })).toBeInTheDocument();
    // 措辞温和：不出现「失败 / 错误 / 409」
    expect(notice.textContent ?? '').not.toContain('失败');
    expect(notice.textContent ?? '').not.toContain('错误');
    expect(notice.textContent ?? '').not.toContain('409');

    // 改名后重提交 → 这次成功
    comboPostError = null;
    fireEvent.change(within(dialog).getByLabelText('套餐名字'), { target: { value: '另一个名字' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '存下来' }));

    await waitFor(() => {
      expect(posted).toHaveLength(2);
    });
  });
});

describe('GAP-2 存成套餐 · 离线', () => {
  it('离线 → 诚实告知、不入离线队列（enqueueRequest 未被调用）', async () => {
    const log = makeLog({ id: 1, name: '全脂牛奶', foodItemId: 42, kcal: 134, mealType: 'breakfast' });
    stubFetch([log]);
    const enqueueSpy = vi.spyOn(offlineQueue, 'enqueueRequest');
    renderDiary();

    fireEvent.click(await screen.findByTestId('save-combo-breakfast'));
    const dialog = await screen.findByRole('dialog', { name: '给这一餐起个名字' });

    // 提交时断网
    simulateOffline = true;
    fireEvent.click(within(dialog).getByRole('button', { name: '存下来' }));

    const notice = await within(dialog).findByTestId('save-combo-notice');
    expect(notice.textContent).toContain('联网了再来存一次就好');
    // 🔴 关键：不入离线队列（同名 409 会永久堵队列）
    expect(enqueueSpy).not.toHaveBeenCalled();
    // 弹窗保留，用户联网后可直接重试
    expect(screen.getByRole('dialog', { name: '给这一餐起个名字' })).toBeInTheDocument();
  });
});
