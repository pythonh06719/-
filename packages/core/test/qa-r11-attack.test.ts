/**
 * QA 独立证伪攻击测试（qa- 前缀，Edward）。
 *
 * 不重复工程师已覆盖的用例，专挑「报告里说验证过但可能偷工」的角度攻击：
 * 1. readExportWins 脏输入补漏：`{wins: 42}` / `{wins: "not-array"}`（数字/字符串作 wins 值）
 *    —— 工程师用例覆盖了 raw=42 与 {wins:'不是数组'}，但没覆盖「wins 键的值是数字」；
 * 2. distinctFoodKeys 用**真实的 201 条不同食物**攻击默认上限 200
 *    —— 工程师只用了 limit:3 的小样本与常量断言，没跑过真实规模。
 *
 * 本文件只攻击 core 纯函数，零 IO。
 */

import { describe, expect, it } from 'vitest';

import { readExportWins } from '../src/export/payload';
import { DISTINCT_FOOD_LIMIT, distinctFoodKeys } from '../src/food/identity';
import type { FoodRefRow } from '../src/food/identity';

describe('QA 攻击 · readExportWins 脏输入（E2 补漏）', () => {
  it('{wins: 42}（wins 值是数字）→ [] 不抛错', () => {
    expect(() => readExportWins({ wins: 42 })).not.toThrow();
    expect(readExportWins({ wins: 42 })).toEqual([]);
  });

  it('{wins: "not-array"}（wins 值是字符串）→ [] 不抛错', () => {
    expect(() => readExportWins({ wins: 'not-array' })).not.toThrow();
    expect(readExportWins({ wins: 'not-array' })).toEqual([]);
  });

  it('wins 数组里嵌套数组 / 布尔 → 逐条过滤不抛错', () => {
    const raw = {
      wins: [
        ['嵌套数组'],
        true,
        { date: '2026-09-23', text: '好的一条' },
      ],
    };
    expect(() => readExportWins(raw)).not.toThrow();
    expect(readExportWins(raw)).toEqual([{ date: '2026-09-23', text: '好的一条' }]);
  });
});

describe('QA 攻击 · distinctFoodKeys 真实规模 201 种（D3 补漏）', () => {
  it('201 条不同食物 → 默认上限 200：names=200、count=201（截断前真实值）、truncated=true', () => {
    const rows: FoodRefRow[] = Array.from({ length: 201 }, (_, index) => ({
      foodItemId: null,
      customName: `食物-${String(index).padStart(3, '0')}`,
    }));
    const result = distinctFoodKeys(rows);
    expect(DISTINCT_FOOD_LIMIT).toBe(200);
    expect(result.names).toHaveLength(200);
    expect(result.count).toBe(201);
    expect(result.truncated).toBe(true);
  });

  it('同一天同一食物记 2 次 → 只计 1 种（K16 口径）', () => {
    const rows: FoodRefRow[] = [
      { foodItemId: null, customName: '米饭' },
      { foodItemId: null, customName: '米饭' },
      { foodItemId: null, customName: '面条' },
    ];
    const result = distinctFoodKeys(rows);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(false);
  });
});
