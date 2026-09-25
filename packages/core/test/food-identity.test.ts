/**
 * 食物身份归一测试（`food/identity.ts`，R11.5 / R11.7 共用的**唯一口径**）。
 *
 * 钉死契约（AC-11.7.7 / AC-11.5.1 / D-4）：
 * - 大小写与首尾空格归一为 1 种；
 * - 内部连续空白（含 `\n` / `\t`）折叠为单空格后归一；
 * - 库内条目（有 `foodName`）与同名快加条目（只有 `customName`）**合并为 1 种**；
 * - 名称为空但有 `foodItemId` → 回落 `food:<id>`；
 * - 名称为空且 `foodItemId` 为 `null` → `null`，不计入；
 * - `limit` 截断时 `count` 仍是真实总数、`truncated === true`。
 */

import { describe, expect, it } from 'vitest';

import {
  DISTINCT_FOOD_LIMIT,
  distinctFoodKeys,
  foodIdentity,
  normalizeFoodName,
} from '../src/index';
import type { FoodRefRow } from '../src/index';

describe('normalizeFoodName', () => {
  it('trim + 小写', () => {
    expect(normalizeFoodName('  Milk Tea  ')).toBe('milk tea');
    expect(normalizeFoodName('拿铁')).toBe('拿铁');
  });

  it('折叠内部空白（含换行与制表符）', () => {
    expect(normalizeFoodName('番茄\n炒蛋')).toBe('番茄 炒蛋');
    expect(normalizeFoodName('番茄\t炒   蛋')).toBe('番茄 炒 蛋');
    expect(normalizeFoodName('  番茄 炒蛋\n')).toBe('番茄 炒蛋');
  });

  it('空串 / 纯空白 / 非字符串 → 空串', () => {
    expect(normalizeFoodName('')).toBe('');
    expect(normalizeFoodName('   \n\t ')).toBe('');
    expect(normalizeFoodName(undefined as unknown as string)).toBe('');
  });
});

describe('foodIdentity', () => {
  it('显示名称优先：foodName 覆盖 customName', () => {
    expect(foodIdentity({ foodItemId: 7, customName: '自制奶茶', foodName: '奶茶' })).toBe('奶茶');
  });

  it('只有 customName 时用 customName', () => {
    expect(foodIdentity({ foodItemId: null, customName: ' 楼下麻辣烫 ', foodName: null })).toBe(
      '楼下麻辣烫',
    );
  });

  it('名称为空 + 有 foodItemId → 回落 food:<id>', () => {
    expect(foodIdentity({ foodItemId: 42, customName: null, foodName: null })).toBe('food:42');
    expect(foodIdentity({ foodItemId: 42, customName: '   ', foodName: '' })).toBe('food:42');
  });

  it('名称为空且 foodItemId 为 null → null（不计数）', () => {
    expect(foodIdentity({ foodItemId: null, customName: null, foodName: null })).toBeNull();
    expect(foodIdentity({})).toBeNull();
  });
});

describe('distinctFoodKeys', () => {
  it('空输入 → 空结果', () => {
    expect(distinctFoodKeys([])).toEqual({ names: [], count: 0, truncated: false });
  });

  it('同一食物不同大小写 / 首尾空格 → 归一为 1 种', () => {
    const rows: FoodRefRow[] = [
      { foodItemId: null, customName: 'Milk Tea' },
      { foodItemId: null, customName: '  milk tea  ' },
      { foodItemId: null, customName: 'MILK TEA' },
    ];
    const result = distinctFoodKeys(rows);
    expect(result.count).toBe(1);
    expect(result.names).toEqual(['Milk Tea']);
    expect(result.truncated).toBe(false);
  });

  it('名称含内部连续空格与 \\n → 折叠后合并', () => {
    const rows: FoodRefRow[] = [
      { foodItemId: null, customName: '番茄 炒蛋' },
      { foodItemId: null, customName: '番茄  炒蛋' },
      { foodItemId: null, customName: '番茄\n炒蛋' },
    ];
    expect(distinctFoodKeys(rows).count).toBe(1);
  });

  it('库内条目与同名快加条目 → 合并为 1 种（D-4 的核心验证）', () => {
    const rows: FoodRefRow[] = [
      { foodItemId: 11, customName: null, foodName: '番茄炒蛋' },
      { foodItemId: null, customName: '番茄炒蛋', foodName: null },
      { foodItemId: 11, customName: '番茄炒蛋', foodName: '番茄炒蛋' },
    ];
    const result = distinctFoodKeys(rows);
    expect(result.count).toBe(1);
    expect(result.names).toEqual(['番茄炒蛋']);
  });

  it('名称为空的不同库内条目 → 按 food:<id> 各自独立', () => {
    const rows: FoodRefRow[] = [
      { foodItemId: 1, customName: null, foodName: null },
      { foodItemId: 2, customName: null, foodName: null },
      { foodItemId: 1, customName: null, foodName: null },
    ];
    const result = distinctFoodKeys(rows);
    expect(result.count).toBe(2);
    expect(result.names).toEqual(['', '']);
  });

  it('names 与首次出现顺序一致（输入顺序 = 最早出现日期顺序）', () => {
    const rows: FoodRefRow[] = [
      { foodItemId: null, customName: '米饭' },
      { foodItemId: null, customName: '青菜' },
      { foodItemId: null, customName: '米饭' },
      { foodItemId: null, customName: '豆腐' },
    ];
    expect(distinctFoodKeys(rows).names).toEqual(['米饭', '青菜', '豆腐']);
  });

  it('超过 limit → names 截断、count 为真实总数、truncated = true', () => {
    const rows: FoodRefRow[] = Array.from({ length: 5 }, (_, index) => ({
      foodItemId: null,
      customName: `食物${index + 1}`,
    }));
    const result = distinctFoodKeys(rows, { limit: 3 });
    expect(result.names).toEqual(['食物1', '食物2', '食物3']);
    expect(result.count).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('默认上限为 200（AC-11.7.4）', () => {
    expect(DISTINCT_FOOD_LIMIT).toBe(200);
    const rows: FoodRefRow[] = Array.from({ length: 201 }, (_, index) => ({
      foodItemId: null,
      customName: `食物${index}`,
    }));
    const result = distinctFoodKeys(rows);
    expect(result.names).toHaveLength(200);
    expect(result.count).toBe(201);
    expect(result.truncated).toBe(true);
  });
});
