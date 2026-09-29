/**
 * 饮食记录「展示名」前端测试 —— 修日记列表「食物 #45」显示缺陷。
 *
 * ## 缺陷回顾
 *
 * 普通记录（选食物库条目）`customName` 为 null，契约原先也没有名字字段，
 * 于是 `DiaryPage` 只能显示 `食物 #45`；而改份量弹窗因额外查了 `GET /foods/:id` 显示是对的。
 * 修复后服务端返回派生字段 `foodName`（= 食物库名快照），前端统一走 `resolveMealLogName`。
 *
 * ## 钉死
 * ★ 核心：`{ foodItemId:45, customName:null, foodName:'米饭（白，蒸）' }` → 页面显示「米饭（白，蒸）」，
 *   **不**显示「食物 #45」；
 * ② 兼容旧响应：`foodName` 缺失（`undefined`）→ 仍退化到「食物 #45」，不崩；
 * ③ `customName` 有值时**优先用 customName**（用户改过的显示名不被 foodName 覆盖）；
 * ④ emoji 用的是**解析后的名字**（`MealItemRow` 入参已改为父组件解析好的 `name`）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ListMealsResponse, MealLog, MealType } from '@qsh/shared-types';
import DiaryPage from '@/pages/diary/DiaryPage';
import { resolveMealLogName } from '@/lib/meal-name';
import { todayKey } from '@/lib/format';
import { cacheClearAll } from '@/lib/local-cache';

const TODAY = todayKey();

/** 建一条 `MealLog`；`foodName` 仅在显式传入时写入（模拟旧响应 / 新响应两种形态）。 */
function makeLog(input: {
  id: number;
  foodItemId: number | null;
  customName: string | null;
  foodName?: string | null;
  kcal?: number;
  mealType?: MealType;
}): MealLog {
  const log: MealLog = {
    id: input.id,
    userId: 1,
    loggedDate: TODAY,
    mealType: input.mealType ?? 'lunch',
    foodItemId: input.foodItemId,
    customName: input.customName,
    grams: 150,
    servingUnit: null,
    servingQty: null,
    kcal: input.kcal ?? 200,
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
  if (input.foodName !== undefined) {
    log.foodName = input.foodName;
  }
  return log;
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

function stubFetch(logs: MealLog[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/meals')) {
        return ok(mealsResponse(logs));
      }
      if (url.includes('/weights')) {
        return ok({ points: [], movingAverage7: [], stats: {}, forecast: [], goalProgress: null });
      }
      if (url.includes('/dashboard')) {
        return ok({ budget: null });
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

beforeEach(() => {
  cacheClearAll();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveMealLogName（纯函数口径）', () => {
  it('优先级：customName > foodName > 食物 #id', () => {
    expect(
      resolveMealLogName({ customName: '我的蒸蛋', foodName: '蒸蛋', foodItemId: 7 }),
    ).toBe('我的蒸蛋');
    expect(resolveMealLogName({ customName: null, foodName: '米饭', foodItemId: 45 })).toBe('米饭');
    expect(
      resolveMealLogName({ customName: null, foodName: null, foodItemId: 45 }),
    ).toBe('食物 #45');
  });

  it('foodName 缺失（旧响应）→ 回落食物 #id；foodItemId 也为空 → 食物 #—', () => {
    expect(resolveMealLogName({ customName: null, foodItemId: 45 })).toBe('食物 #45');
    expect(resolveMealLogName({ customName: null, foodItemId: null })).toBe('食物 #—');
  });

  it('空白值视为缺失（不显示空串）', () => {
    expect(resolveMealLogName({ customName: '   ', foodName: '米饭', foodItemId: 45 })).toBe('米饭');
    expect(resolveMealLogName({ customName: '', foodName: '  ', foodItemId: 45 })).toBe('食物 #45');
  });

  it('自定义兜底串（供改份量面板复用）', () => {
    expect(resolveMealLogName({ customName: null, foodName: null, foodItemId: 9 }, '这条记录')).toBe(
      '这条记录',
    );
  });
});

describe('饮食日记列表 · 展示名（★ 核心缺陷）', () => {
  it('库内条目显示食物名，而不是「食物 #45」', async () => {
    const log = makeLog({ id: 45, foodItemId: 45, customName: null, foodName: '米饭（白，蒸）' });
    stubFetch([log]);
    renderDiary();

    expect(await screen.findByText('米饭（白，蒸）')).toBeInTheDocument();
    expect(screen.queryByText('食物 #45')).toBeNull();
  });

  it('兼容旧响应：foodName 缺失 → 仍退化到「食物 #45」，不崩', async () => {
    const log = makeLog({ id: 45, foodItemId: 45, customName: null });
    stubFetch([log]);
    renderDiary();

    expect(await screen.findByText('食物 #45')).toBeInTheDocument();
  });

  it('customName 有值时优先用 customName（不被 foodName 覆盖）', async () => {
    const log = makeLog({
      id: 7,
      foodItemId: 7,
      customName: '我的减脂蒸蛋',
      foodName: '蒸蛋',
    });
    stubFetch([log]);
    renderDiary();

    expect(await screen.findByText('我的减脂蒸蛋')).toBeInTheDocument();
    expect(screen.queryByText('蒸蛋')).toBeNull();
  });

  it('emoji 与展示名同源：米饭 → 🍚（此前 customName 为 null 会错兜底成 🍴）', async () => {
    const log = makeLog({ id: 45, foodItemId: 45, customName: null, foodName: '米饭（白，蒸）' });
    stubFetch([log]);
    renderDiary();

    const row = await screen.findByTestId('meal-item-45');
    expect(within(row).getByText('🍚')).toBeInTheDocument();
    expect(within(row).queryByText('🍴')).toBeNull();
  });
});
