/**
 * 餐次排序 / 跨餐移动测试（`meal/reorder.ts`，R3.8 / AC-3.8.10）。
 *
 * 钉死契约：
 * - 同餐内顺序完全反转 → 映射为反序，其它餐次不变；
 * - **跨餐移动** → 该条 `mealType` 变为目标餐并排到指定位置，源餐剩余项 compact 为 0..n-1；
 * - 目标餐为空 → 该条成为唯一一项，`sortOrder = 0`；
 * - 未知 id 静默忽略；重复 id 按首次出现去重；
 * - 部分 id → 未列出的项保持原餐次，仅在 compact 时重编号；
 * - 空数组 → no-op；幂等；`compact: false` 时源餐保留空洞。
 */

import { describe, expect, it } from 'vitest';

import { applyReorder } from '../src/index';
import type { ReorderItem } from '../src/index';

type Meal = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/** 造一条最小排序状态。 */
function item(id: number, mealType: Meal, sortOrder: number): ReorderItem<Meal> {
  return { id, mealType, sortOrder };
}

/** 按 id 升序取出结果，便于断言。 */
function sortedById(items: readonly ReorderItem<Meal>[]): ReorderItem<Meal>[] {
  return [...items].sort((left, right) => left.id - right.id);
}

describe('applyReorder（R3.8）', () => {
  it('同餐内顺序完全反转 → 反序映射，其它餐次不变', () => {
    const items = [
      item(1, 'breakfast', 0),
      item(2, 'breakfast', 1),
      item(3, 'breakfast', 2),
      item(4, 'lunch', 0),
    ];
    const result = applyReorder(items, 'breakfast', [3, 2, 1]);
    expect(result).toHaveLength(4);
    expect(sortedById(result)).toEqual([
      { id: 1, mealType: 'breakfast', sortOrder: 2 },
      { id: 2, mealType: 'breakfast', sortOrder: 1 },
      { id: 3, mealType: 'breakfast', sortOrder: 0 },
      { id: 4, mealType: 'lunch', sortOrder: 0 },
    ]);
  });

  it('跨餐移动：把午餐一条移到早餐指定位置，源餐 compact 为 0..n-1', () => {
    const items = [
      item(1, 'breakfast', 0),
      item(2, 'breakfast', 1),
      item(10, 'lunch', 0),
      item(11, 'lunch', 1),
      item(12, 'lunch', 2),
    ];
    // 把 11 移到早餐的第 1 位（在 1 之前）
    const result = applyReorder(items, 'breakfast', [11, 1, 2]);
    expect(sortedById(result)).toEqual([
      { id: 1, mealType: 'breakfast', sortOrder: 1 },
      { id: 2, mealType: 'breakfast', sortOrder: 2 },
      { id: 10, mealType: 'lunch', sortOrder: 0 },
      { id: 11, mealType: 'breakfast', sortOrder: 0 },
      { id: 12, mealType: 'lunch', sortOrder: 1 },
    ]);
  });

  it('目标餐为空（拖到空餐）→ 成为唯一一项，sortOrder = 0', () => {
    const items = [item(1, 'lunch', 0), item(2, 'lunch', 1)];
    const result = applyReorder(items, 'snack', [2]);
    expect(sortedById(result)).toEqual([
      { id: 1, mealType: 'lunch', sortOrder: 0 },
      { id: 2, mealType: 'snack', sortOrder: 0 },
    ]);
  });

  it('未知 id → 静默忽略，不影响其它项', () => {
    const items = [item(1, 'lunch', 0), item(2, 'lunch', 1)];
    const result = applyReorder(items, 'lunch', [2, 999, 1]);
    expect(sortedById(result)).toEqual([
      { id: 1, mealType: 'lunch', sortOrder: 1 },
      { id: 2, mealType: 'lunch', sortOrder: 0 },
    ]);
  });

  it('重复 id → 按首次出现位置去重', () => {
    const items = [item(1, 'lunch', 0), item(2, 'lunch', 1), item(3, 'lunch', 2)];
    const result = applyReorder(items, 'lunch', [3, 3, 1, 1, 2]);
    expect(sortedById(result)).toEqual([
      { id: 1, mealType: 'lunch', sortOrder: 1 },
      { id: 2, mealType: 'lunch', sortOrder: 2 },
      { id: 3, mealType: 'lunch', sortOrder: 0 },
    ]);
  });

  it('部分 id → 未列出的项保持原餐次，仅在 compact 时重编号', () => {
    const items = [
      item(1, 'lunch', 0),
      item(2, 'lunch', 1),
      item(3, 'lunch', 2),
      item(4, 'dinner', 0),
    ];
    // 只把 3 提到最前；1 / 2 仍在午餐并重编号为 1 / 2；晚餐不动
    const result = applyReorder(items, 'lunch', [3]);
    expect(sortedById(result)).toEqual([
      { id: 1, mealType: 'lunch', sortOrder: 1 },
      { id: 2, mealType: 'lunch', sortOrder: 2 },
      { id: 3, mealType: 'lunch', sortOrder: 0 },
      { id: 4, mealType: 'dinner', sortOrder: 0 },
    ]);
  });

  it('空数组 → no-op（映射与输入一致）', () => {
    const items = [item(1, 'lunch', 0), item(2, 'lunch', 1), item(3, 'dinner', 0)];
    const result = applyReorder(items, 'lunch', []);
    expect(sortedById(result)).toEqual(sortedById(items));
  });

  it('幂等：对同一输出再跑一次得到相同结果', () => {
    const items = [
      item(1, 'breakfast', 0),
      item(2, 'breakfast', 1),
      item(3, 'lunch', 0),
      item(4, 'lunch', 1),
    ];
    const first = applyReorder(items, 'breakfast', [3, 1, 2]);
    const second = applyReorder(first, 'breakfast', [3, 1, 2]);
    expect(sortedById(second)).toEqual(sortedById(first));
  });

  it('compact: false → 源餐保留空洞，未列出的项原样不动', () => {
    const items = [
      item(1, 'lunch', 0),
      item(2, 'lunch', 1),
      item(3, 'lunch', 2),
      item(4, 'breakfast', 0),
    ];
    // 3 移到早餐首位；午餐剩下 1 / 2 保持 0 / 1（因为它们的原 sortOrder 就是 0 / 1）
    const result = applyReorder(items, 'breakfast', [3, 4], { compact: false });
    expect(sortedById(result)).toEqual([
      { id: 1, mealType: 'lunch', sortOrder: 0 },
      { id: 2, mealType: 'lunch', sortOrder: 1 },
      { id: 3, mealType: 'breakfast', sortOrder: 0 },
      { id: 4, mealType: 'breakfast', sortOrder: 1 },
    ]);

    // 保留空洞的典型场景：源餐原为 0,1,2,3，移走第 2 项后剩下 0,2,3
    const holed = [
      item(1, 'lunch', 0),
      item(2, 'lunch', 1),
      item(3, 'lunch', 2),
      item(4, 'lunch', 3),
    ];
    const kept = applyReorder(holed, 'snack', [2], { compact: false });
    expect(sortedById(kept)).toEqual([
      { id: 1, mealType: 'lunch', sortOrder: 0 },
      { id: 2, mealType: 'snack', sortOrder: 0 },
      { id: 3, mealType: 'lunch', sortOrder: 2 },
      { id: 4, mealType: 'lunch', sortOrder: 3 },
    ]);
  });

  it('结果与 items 一一对应且长度相同', () => {
    const items = [item(5, 'lunch', 0), item(6, 'dinner', 0), item(7, 'snack', 0)];
    const result = applyReorder(items, 'dinner', [5, 6]);
    expect(result).toHaveLength(items.length);
    expect(result.map((row) => row.id)).toEqual(items.map((row) => row.id));
  });
});
