/**
 * 「重复记录温和提示」判定口径单测（core/meal/same-item.ts / D-2）。
 *
 * 本模块只回答一个问题：**同一天 + 同一餐里是不是已经有同一样食物**。
 * 用例钉死它的**边界**（尤其是「不该提示」的那几类，防止提示轰炸）：
 *
 * ① ★ 同日同餐 + 同 `foodItemId` → 命中；
 * ② 同 `foodItemId` 但**不同餐次** → 不命中（早餐记过的，午餐再记是正常的）；
 * ③ 同 `foodItemId` 但**不同日期** → 不命中；
 * ④ 快加卡按 `customName` 同名命中（去空白后同名也算）；
 * ⑤ 名字只相近 / 不同 → 不命中；
 * ⑥ 候选没有任何身份（无 id 也无名）→ 不命中（绝不误报）；
 * ⑦ 防御：脏输入（`null` / 非字符串日期）不抛错、按不命中处理。
 */

import { describe, expect, it } from 'vitest';

import { findSameMealItem, hasSameMealItem } from '../src/meal/same-item';
import type { MealItemIdentity } from '../src/meal/same-item';

/** 造一条已有记录（最小投影）。 */
function row(overrides: Partial<MealItemIdentity> = {}): MealItemIdentity {
  return {
    loggedDate: '2026-09-12',
    mealType: 'lunch',
    foodItemId: null,
    customName: null,
    ...overrides,
  };
}

describe('D-2 findSameMealItem 判定口径', () => {
  it('★ 同日同餐 + 同 foodItemId → 命中', () => {
    const existing = [row({ foodItemId: 7 })];
    const hit = findSameMealItem(existing, {
      loggedDate: '2026-09-12',
      mealType: 'lunch',
      foodItemId: 7,
    });
    expect(hit).not.toBeNull();
    expect(hit?.foodItemId).toBe(7);
    expect(hasSameMealItem(existing, { loggedDate: '2026-09-12', mealType: 'lunch', foodItemId: 7 })).toBe(
      true,
    );
  });

  it('② 同 foodItemId 但不同餐次 → 不命中（早餐记过，午餐再记是正常的）', () => {
    const existing = [row({ mealType: 'breakfast', foodItemId: 7 })];
    expect(
      findSameMealItem(existing, { loggedDate: '2026-09-12', mealType: 'lunch', foodItemId: 7 }),
    ).toBeNull();
  });

  it('③ 同 foodItemId 但不同日期 → 不命中', () => {
    const existing = [row({ loggedDate: '2026-09-11', foodItemId: 7 })];
    expect(
      findSameMealItem(existing, { loggedDate: '2026-09-12', mealType: 'lunch', foodItemId: 7 }),
    ).toBeNull();
  });

  it('④ 快加卡按 customName 同名命中（去空白后同名也算）', () => {
    const existing = [row({ customName: '楼下麻辣烫' })];
    expect(
      findSameMealItem(existing, { loggedDate: '2026-09-12', mealType: 'lunch', customName: '  楼下麻辣烫 ' }),
    ).not.toBeNull();
    // 大小写 / 全角空白也归一到同一把键
    const ascii = [row({ customName: 'Milk Tea' })];
    expect(
      findSameMealItem(ascii, { loggedDate: '2026-09-12', mealType: 'lunch', customName: 'milktea' }),
    ).not.toBeNull();
  });

  it('⑤ 名字只相近 / 不同 → 不命中（防提示轰炸）', () => {
    const existing = [row({ customName: '番茄鸡蛋面' })];
    expect(
      findSameMealItem(existing, { loggedDate: '2026-09-12', mealType: 'lunch', customName: '番茄炒蛋' }),
    ).toBeNull();
  });

  it('命名空间不串：食物库条目的 id 不会与快加卡的名字互相命中', () => {
    const existing = [row({ foodItemId: 7, customName: null })];
    // 拿同样的 id 当「名字」去比，不该命中
    expect(
      findSameMealItem(existing, { loggedDate: '2026-09-12', mealType: 'lunch', customName: '7' }),
    ).toBeNull();
    // 拿名字去比一条只有 id 的记录，也不该命中
    const onlyName = [row({ customName: '米饭', foodItemId: null })];
    expect(
      findSameMealItem(onlyName, { loggedDate: '2026-09-12', mealType: 'lunch', foodItemId: 7 }),
    ).toBeNull();
  });

  it('⑥ 候选没有任何身份（无 id 也无名）→ 不命中（绝不误报）', () => {
    const existing = [row({ foodItemId: 7 }), row({ customName: '米饭' })];
    expect(findSameMealItem(existing, { loggedDate: '2026-09-12', mealType: 'lunch' })).toBeNull();
    expect(
      findSameMealItem(existing, { loggedDate: '2026-09-12', mealType: 'lunch', foodItemId: null, customName: '' }),
    ).toBeNull();
    expect(hasSameMealItem(existing, { loggedDate: '2026-09-12', mealType: 'lunch' })).toBe(false);
  });

  it('⑦ 防御：脏输入不抛错，按不命中处理', () => {
    const existing = [row({ foodItemId: 7 })];
    expect(
      findSameMealItem(existing, null as unknown as Parameters<typeof findSameMealItem>[1]),
    ).toBeNull();
    expect(
      findSameMealItem(existing, {
        loggedDate: 20260912 as unknown as string,
        mealType: 'lunch',
        foodItemId: 7,
      }),
    ).toBeNull();
    // 空列表 / 列表里有脏元素
    expect(findSameMealItem([], { loggedDate: '2026-09-12', mealType: 'lunch', foodItemId: 7 })).toBeNull();
    expect(
      findSameMealItem(
        [null as unknown as MealItemIdentity, row({ foodItemId: 7 })],
        { loggedDate: '2026-09-12', mealType: 'lunch', foodItemId: 7 },
      ),
    ).not.toBeNull();
  });
});
