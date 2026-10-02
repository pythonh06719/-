/**
 * 食物食用历史纯函数测试（core/food/history.ts，D-5）。
 *
 * 钉死四件事：
 * ① **身份归一复用 `identity.ts`**（K16）：库内条目与同名快加条目合并为同一条序列；
 * ② **日期倒序** + 同日按 `id` 稳定 tie-break；
 * ③ **脏日期跳过**（不参与排序、不进结果）；
 * ④ 🔴 **零汇总**：返回值里只有明细，**没有**任何条数 / 天数字段。
 *
 * 这是 core 侧的门禁；服务端那条「API 结论 == core 结论」的一致性门禁在
 * `apps/api/test/foods-history.e2e.test.ts`。两侧都要绿。
 */

import { describe, expect, it } from 'vitest';

import { normalizeFoodName } from '../src/food/identity';
import {
  FOOD_HISTORY_DEFAULTS,
  selectFoodHistoryEntries,
  type FoodHistoryRow,
} from '../src/food/history';

/** 本文件统一使用的目标食物名（所有用例围绕它构造数据）。 */
const FOOD_NAME = '米饭';

/**
 * 造一条扫描行。
 *
 * ⚠️ 默认带上 `customName: FOOD_NAME`：`foodIdentity` 对「既无显示名、又无 id」的行返回
 * `null`（那是**无名无 id**的脏数据，不该被算成一种）。若默认值是全空，排序 / 截断那几组
 * 用例会全部返回 `[]` —— 那是测试数据没构造对，不是被测逻辑过滤掉了东西。
 */
function makeRow(overrides: Partial<FoodHistoryRow> & { id: number; loggedDate: string }): FoodHistoryRow {
  return {
    foodItemId: null,
    customName: FOOD_NAME,
    foodName: null,
    mealType: 'lunch',
    grams: 100,
    servingUnit: null,
    servingQty: null,
    ...overrides,
  };
}

/** 目标键：与 core 的 `foodIdentity` 同源算出（不给 test 造第二套归一）。 */
function targetKeyFor(foodName: string = FOOD_NAME): string {
  return normalizeFoodName(foodName);
}

describe('selectFoodHistoryEntries · 身份归一（K16）', () => {
  it('★ 库内条目与同名快加条目合并为同一条序列（D-4 口径）', () => {
    const target = targetKeyFor('番茄炒蛋');
    const rows: FoodHistoryRow[] = [
      makeRow({ id: 1, loggedDate: '2026-01-01', foodItemId: 1, foodName: '番茄炒蛋' }),
      makeRow({ id: 2, loggedDate: '2026-01-03', customName: '番茄炒蛋' }),
      makeRow({ id: 3, loggedDate: '2026-01-02', foodItemId: 1, foodName: '番茄炒蛋' }),
    ];

    const entries = selectFoodHistoryEntries(rows, target);
    // 三条都在（合并），且日期倒序
    expect(entries.map((entry) => entry.loggedDate)).toEqual([
      '2026-01-03',
      '2026-01-02',
      '2026-01-01',
    ]);
  });

  it('★ 归一吃得下大小写、首尾空白与内部多空格（与 normalizeFoodName 同口径）', () => {
    const target = targetKeyFor('楼下麻辣烫');
    const rows: FoodHistoryRow[] = [
      makeRow({ id: 1, loggedDate: '2026-02-01', customName: '楼下麻辣烫' }),
      makeRow({ id: 2, loggedDate: '2026-02-02', customName: '  楼下麻辣烫  ' }),
      makeRow({ id: 3, loggedDate: '2026-02-03', customName: '楼下麻辣烫' }),
    ];

    expect(selectFoodHistoryEntries(rows, target)).toHaveLength(3);
  });

  it('不同名的记录不混进来', () => {
    const target = targetKeyFor('番茄炒蛋');
    const rows: FoodHistoryRow[] = [
      makeRow({ id: 1, loggedDate: '2026-01-01', customName: '番茄炒蛋' }),
      makeRow({ id: 2, loggedDate: '2026-01-02', customName: '番茄炒蛋饭' }),
      makeRow({ id: 3, loggedDate: '2026-01-03', customName: '完全另一道菜' }),
    ];

    expect(selectFoodHistoryEntries(rows, target)).toHaveLength(1);
  });

  it('★ 显示名为空的库内行按 `food:<id>` 回落，仍能被同 id 的目标键命中', () => {
    // 目标食物名缺失 → 身份键回落 `food:7`
    const rows: FoodHistoryRow[] = [
      makeRow({ id: 1, loggedDate: '2026-01-01', foodItemId: 7, foodName: null, customName: null }),
    ];
    expect(selectFoodHistoryEntries(rows, 'food:7')).toHaveLength(1);
    // 换一个 id 就不该命中
    expect(selectFoodHistoryEntries(rows, 'food:8')).toHaveLength(0);
  });

  it('★ 无名无 id 的脏行不算一种（`foodIdentity` 返回 null → 被跳过）', () => {
    // 既没有显示名、也没有 foodItemId —— 归一函数对它返回 null
    const rows: FoodHistoryRow[] = [
      makeRow({ id: 1, loggedDate: '2026-01-01', foodItemId: null, customName: null, foodName: null }),
    ];
    expect(selectFoodHistoryEntries(rows, targetKeyFor(FOOD_NAME))).toEqual([]);
  });

  it('空 targetKey / 空输入 → 空数组（不是 null）', () => {
    const row = makeRow({ id: 1, loggedDate: '2026-01-01' });
    expect(selectFoodHistoryEntries([], '')).toEqual([]);
    expect(selectFoodHistoryEntries([row], '')).toEqual([]);
    expect(selectFoodHistoryEntries([], targetKeyFor())).toEqual([]);
  });
});

describe('selectFoodHistoryEntries · 排序与截断', () => {
  it('日期倒序：最新的在最前', () => {
    const target = targetKeyFor('米饭');
    const rows: FoodHistoryRow[] = [
      makeRow({ id: 1, loggedDate: '2026-01-05' }),
      makeRow({ id: 2, loggedDate: '2026-07-20' }),
      makeRow({ id: 3, loggedDate: '2026-03-15' }),
    ];

    expect(selectFoodHistoryEntries(rows, target).map((entry) => entry.loggedDate)).toEqual([
      '2026-07-20',
      '2026-03-15',
      '2026-01-05',
    ]);
  });

  it('同日多条 → 按 id 降序（确定性 tie-break，不随机跳动）', () => {
    const target = targetKeyFor('米饭');
    const rows: FoodHistoryRow[] = [
      makeRow({ id: 1, loggedDate: '2026-06-06' }),
      makeRow({ id: 3, loggedDate: '2026-06-06' }),
      makeRow({ id: 2, loggedDate: '2026-06-06' }),
    ];

    expect(selectFoodHistoryEntries(rows, target).map((entry) => entry.grams)).toEqual([100, 100, 100]);
    // 用 id 排序的等价断言：构造可区分的 grams
    const distinct = [
      makeRow({ id: 1, loggedDate: '2026-06-06', grams: 111 }),
      makeRow({ id: 3, loggedDate: '2026-06-06', grams: 333 }),
      makeRow({ id: 2, loggedDate: '2026-06-06', grams: 222 }),
    ];
    expect(selectFoodHistoryEntries(distinct, target).map((entry) => entry.grams)).toEqual([333, 222, 111]);
  });

  it('★ 脏日期被跳过（不参与排序、不进结果）', () => {
    const target = targetKeyFor();
    const rows: FoodHistoryRow[] = [
      makeRow({ id: 1, loggedDate: '2026-01-01' }),
      // ⚠️ `'not-a-date'` 正好 10 个字符 —— 只判长度的守卫会把它放行，
      // 且它在字符串序里排在所有合法日期**之前**，直接把整个序列的倒序打乱。
      makeRow({ id: 2, loggedDate: 'not-a-date' }),
      makeRow({ id: 3, loggedDate: '' }),
      makeRow({ id: 4, loggedDate: '2026' }),
      makeRow({ id: 5, loggedDate: '2026-1-1' }),
      makeRow({ id: 6, loggedDate: '20260101' }),
    ];

    const entries = selectFoodHistoryEntries(rows, target);
    expect(entries.map((entry) => entry.loggedDate)).toEqual(['2026-01-01']);
  });

  it('★ 脏日期不会因「字符串序靠前」而污染倒序（回归：上面那条的真实后果）', () => {
    const target = targetKeyFor();
    const rows: FoodHistoryRow[] = [
      makeRow({ id: 1, loggedDate: '2026-05-01' }),
      makeRow({ id: 2, loggedDate: '2026-09-01' }),
      makeRow({ id: 3, loggedDate: '2026-06-01' }),
    ];
    // 合法数据本身的倒序必须正确（脏数据用例之外，单独钉一次）
    expect(selectFoodHistoryEntries(rows, target).map((entry) => entry.loggedDate)).toEqual([
      '2026-09-01',
      '2026-06-01',
      '2026-05-01',
    ]);
  });

  it('limit 生效：只返回最近的 N 条', () => {
    const target = targetKeyFor('米饭');
    const rows: FoodHistoryRow[] = ['01', '02', '03', '04', '05'].map((day, index) =>
      makeRow({ id: index + 1, loggedDate: `2026-01-${day}` }),
    );

    expect(selectFoodHistoryEntries(rows, target, { limit: 2 }).map((entry) => entry.loggedDate)).toEqual([
      '2026-01-05',
      '2026-01-04',
    ]);
  });

  it('limit <= 0 → 空数组（绝不返回「未截断的全量」）', () => {
    const target = targetKeyFor('米饭');
    const rows = [makeRow({ id: 1, loggedDate: '2026-01-01' })];
    expect(selectFoodHistoryEntries(rows, target, { limit: 0 })).toEqual([]);
    expect(selectFoodHistoryEntries(rows, target, { limit: -5 })).toEqual([]);
  });

  it('缺省 limit 走 FOOD_HISTORY_DEFAULTS.limit（30）', () => {
    expect(FOOD_HISTORY_DEFAULTS.limit).toBe(30);
    expect(FOOD_HISTORY_DEFAULTS.maxLimit).toBe(100);
    const target = targetKeyFor('米饭');
    const rows = Array.from({ length: 40 }, (_, index) =>
      makeRow({ id: index + 1, loggedDate: `2026-01-${String(index + 1).padStart(2, '0')}` }),
    );
    expect(selectFoodHistoryEntries(rows, target)).toHaveLength(30);
  });
});

describe('selectFoodHistoryEntries · 🔴 零汇总（QD-6）', () => {
  it('★ 返回的每条只有 5 个字段：日期 + 餐次 + 份量，**无任何汇总、无营养值**', () => {
    const target = targetKeyFor('米饭');
    const rows = [
      makeRow({ id: 1, loggedDate: '2026-01-01', grams: 150, servingUnit: '碗', servingQty: 1 }),
    ];

    const entries = selectFoodHistoryEntries(rows, target);
    expect(entries).toHaveLength(1);
    // 经 `unknown` 中转再取键：接口类型没有索引签名，直接断言成 `Record` 会被 tsc 拦下
    const entry = entries[0] as unknown as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual([
      'grams',
      'loggedDate',
      'mealType',
      'servingQty',
      'servingUnit',
    ]);
    // 汇总类字段一个都没有
    for (const forbidden of ['total', 'count', 'dayCount', 'times', 'frequency']) {
      expect(Object.prototype.hasOwnProperty.call(entry, forbidden)).toBe(false);
    }
  });

  it('无份量的记录如实返回 null（不是 0 —— 「没记」与「记了 0g」性质不同）', () => {
    const target = targetKeyFor('楼下麻辣烫');
    const rows = [
      makeRow({
        id: 1,
        loggedDate: '2026-01-01',
        customName: '楼下麻辣烫',
        grams: null,
        servingUnit: null,
        servingQty: null,
      }),
    ];

    const entry = selectFoodHistoryEntries(rows, target)[0];
    expect(entry?.grams).toBeNull();
    expect(entry?.servingUnit).toBeNull();
    expect(entry?.servingQty).toBeNull();
  });

  it('mealType 原样透传（core 不解释它，由前端翻成「早餐 / 午餐」）', () => {
    const target = targetKeyFor('米饭');
    const rows = [makeRow({ id: 1, loggedDate: '2026-01-01', mealType: 'breakfast' })];
    expect(selectFoodHistoryEntries(rows, target)[0]?.mealType).toBe('breakfast');
  });
});
