/**
 * 套餐明细映射（`mealLogsToComboItems`）单元测试（T01 / GAP-2）。
 *
 * 这是个**纯搬运函数**：把已记录的 `MealLog[]` 映射成 `POST /meal-combos` 的 `items`。
 * 它不计算任何数字，但有两个**必须钉死的不变量**，否则后端会直接拒绝或套餐会显示不出人话：
 * ① 自定义条目（`foodItemId === null`）必须带 `customName` + `kcal`
 *    —— 后端 `prepareComboItem` 对自定义条目强校验这两项；
 * ② `null` 字段不得写进对象（DTO 是 `@IsOptional`，`null` 视为非法值）；
 * ③ `sortOrder` 按下标递增，保住「照这个搭配再记一次」的顺序（AC-3.8.5）。
 */

import { describe, expect, it } from 'vitest';
import type { MealLog, MealType } from '@qsh/shared-types';
import { mealLogsToComboItems } from '@/lib/combo-map';

/** 建一条 `MealLog`（只覆盖本函数用得到的字段，其余给中性默认值）。 */
function makeLog(input: Partial<MealLog> & { id: number }): MealLog {
  return {
    id: input.id,
    userId: 1,
    loggedDate: '2026-09-28',
    mealType: (input.mealType ?? 'breakfast') as MealType,
    foodItemId: input.foodItemId ?? null,
    customName: input.customName ?? null,
    grams: input.grams ?? null,
    servingUnit: input.servingUnit ?? null,
    servingQty: input.servingQty ?? null,
    kcal: input.kcal ?? 0,
    proteinG: input.proteinG ?? null,
    fatG: input.fatG ?? null,
    carbG: input.carbG ?? null,
    fiberG: input.fiberG ?? null,
    sodiumMg: input.sodiumMg ?? null,
    source: input.source ?? 'search',
    comboId: input.comboId ?? null,
    note: input.note ?? null,
    sortOrder: input.sortOrder ?? 0,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  };
}

describe('mealLogsToComboItems · 库内条目', () => {
  it('foodId / customName / 份量 / 营养素全部透传，sortOrder 从 0 开始', () => {
    const log = makeLog({
      id: 1,
      foodItemId: 42,
      customName: '全脂牛奶',
      grams: 250,
      servingUnit: '杯',
      servingQty: 1,
      kcal: 134,
      proteinG: 8.1,
      fatG: 7.2,
      carbG: 9.6,
    });

    expect(mealLogsToComboItems([log])).toEqual([
      {
        sortOrder: 0,
        foodId: 42,
        customName: '全脂牛奶',
        kcal: 134,
        grams: 250,
        servingUnit: '杯',
        servingQty: 1,
        proteinG: 8.1,
        fatG: 7.2,
        carbG: 9.6,
      },
    ]);
  });
});

describe('mealLogsToComboItems · 自定义条目（foodItemId=null）', () => {
  it('不带 foodId 键，必带 customName + kcal（否则后端会拒绝）', () => {
    const log = makeLog({
      id: 2,
      foodItemId: null,
      customName: '楼下麻辣烫',
      grams: 300,
      kcal: 620,
      source: 'quick_add',
    });

    const [item] = mealLogsToComboItems([log]);
    expect(item).not.toHaveProperty('foodId');
    expect(item?.customName).toBe('楼下麻辣烫');
    expect(item?.kcal).toBe(620);
    expect(item?.sortOrder).toBe(0);
  });
});

describe('mealLogsToComboItems · null 字段不得写进对象', () => {
  it('任何 null 字段都不产生键（DTO 里 null 是非法值）', () => {
    const log = makeLog({
      id: 3,
      foodItemId: null,
      customName: '随手记的一顿',
      kcal: 500,
      grams: null,
      servingUnit: null,
      servingQty: null,
      proteinG: null,
      fatG: null,
      carbG: null,
    });

    const [item] = mealLogsToComboItems([log]);
    expect(item).toEqual({ sortOrder: 0, customName: '随手记的一顿', kcal: 500 });
    for (const key of ['foodId', 'grams', 'servingUnit', 'servingQty', 'proteinG', 'fatG', 'carbG']) {
      expect(item).not.toHaveProperty(key);
    }
    // 整个结果里不得出现任何 null 值
    expect(Object.values(item ?? {}).every((value) => value !== null)).toBe(true);
  });
});

describe('mealLogsToComboItems · 空数组', () => {
  it('空输入返回空数组（不抛错）', () => {
    expect(mealLogsToComboItems([])).toEqual([]);
  });
});

describe('mealLogsToComboItems · 顺序', () => {
  it('sortOrder 按下标递增，保住用户看到的搭配顺序', () => {
    const logs = [
      makeLog({ id: 10, foodItemId: 1, customName: 'A', kcal: 100 }),
      makeLog({ id: 11, foodItemId: null, customName: 'B', kcal: 200 }),
      makeLog({ id: 12, foodItemId: 2, customName: 'C', kcal: 300 }),
    ];

    const items = mealLogsToComboItems(logs);
    expect(items.map((item) => item.sortOrder)).toEqual([0, 1, 2]);
    expect(items.map((item) => item.customName)).toEqual(['A', 'B', 'C']);
  });

  it('混合条目：库内 + 自定义共存，各自带对的字段', () => {
    const logs = [
      makeLog({ id: 20, foodItemId: 5, customName: '米饭', grams: 150, kcal: 174 }),
      makeLog({ id: 21, foodItemId: null, customName: '卤蛋', kcal: 78, source: 'quick_add' }),
    ];

    const items = mealLogsToComboItems(logs);
    expect(items[0]).toMatchObject({ foodId: 5, customName: '米饭', kcal: 174, sortOrder: 0 });
    expect(items[1]).not.toHaveProperty('foodId');
    expect(items[1]).toMatchObject({ customName: '卤蛋', kcal: 78, sortOrder: 1 });
  });
});
