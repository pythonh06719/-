/**
 * 待记清单口径（C-3）单测 —— 钉死「清单状态机」的纯逻辑。
 *
 * 覆盖：
 * ① 加一项**去重幂等**（重复点同一样不产生第二行、也不重置已调份量）；
 * ② 移除 / 改份量**不改原数组**（不可变，供 React 直接替换引用）；
 * ③ 提交校验：非空 + 每项克数为合法正数；
 * ④ 清单 → 入账项映射：克数解析 + 逐条热量预估（与既有单条路径同公式）。
 */

import { describe, expect, it } from 'vitest';

import {
  addPendingItem,
  isPendingListRecordable,
  removePendingItem,
  setPendingItemGramsText,
  toBatchItems,
  type PendingMealItem,
} from '../src/meal/batch';

function item(foodId: number, name: string, gramsText = '100', kcalPer100g = 120): PendingMealItem {
  return { foodId, name, gramsText, servingUnit: '克', kcalPer100g };
}

describe('addPendingItem：去重幂等', () => {
  it('新食物 → 追加到末尾', () => {
    const list = addPendingItem([], item(1, '宽粉'));
    expect(list.map((entry) => entry.foodId)).toEqual([1]);
  });

  it('同 foodId 重复加入 → 不新增第二条，且原引用不变', () => {
    const first = addPendingItem([], item(1, '宽粉'));
    const second = addPendingItem(first, item(1, '宽粉（再来一份）'));
    expect(second).toBe(first); // 原引用返回：重复点同一样不产生第二行
    expect(second).toHaveLength(1);
  });

  it('已调过份量后再点同一样 → 不覆盖用户已改好的份量', () => {
    const base = addPendingItem([], item(1, '宽粉', '100'));
    const adjusted = setPendingItemGramsText(base, 1, '200');
    const again = addPendingItem(adjusted, item(1, '宽粉', '100'));
    expect(again[0]?.gramsText).toBe('200');
  });

  it('多种食物各保留一条，顺序 = 加入顺序', () => {
    let list: PendingMealItem[] = [];
    list = addPendingItem(list, item(1, '宽粉'));
    list = addPendingItem(list, item(2, '豆腐皮'));
    list = addPendingItem(list, item(3, '青菜'));
    expect(list.map((entry) => entry.foodId)).toEqual([1, 2, 3]);
  });
});

describe('removePendingItem / setPendingItemGramsText：不可变', () => {
  it('移除一项 → 新数组，原数组不受影响', () => {
    const list = [item(1, '宽粉'), item(2, '豆腐皮')];
    const next = removePendingItem(list, 1);
    expect(next.map((entry) => entry.foodId)).toEqual([2]);
    expect(list).toHaveLength(2);
  });

  it('改份量 → 只改目标项', () => {
    const list = [item(1, '宽粉'), item(2, '豆腐皮')];
    const next = setPendingItemGramsText(list, 2, '55');
    expect(next[1]?.gramsText).toBe('55');
    expect(next[0]?.gramsText).toBe('100');
    expect(list[1]?.gramsText).toBe('100');
  });

  it('移除 / 改份量对不存在的 id 是 no-op', () => {
    const list = [item(1, '宽粉')];
    expect(removePendingItem(list, 99)).toHaveLength(1);
    expect(setPendingItemGramsText(list, 99, '9')[0]?.gramsText).toBe('100');
  });
});

describe('isPendingListRecordable：提交校验', () => {
  it('空清单不可提交', () => {
    expect(isPendingListRecordable([])).toBe(false);
  });

  it('每项克数为正数才可提交', () => {
    expect(isPendingListRecordable([item(1, '宽粉', '100')])).toBe(true);
  });

  it('任一克数为空 / 0 / 非数 → 不可提交', () => {
    expect(isPendingListRecordable([item(1, '宽粉', '')])).toBe(false);
    expect(isPendingListRecordable([item(1, '宽粉', '0')])).toBe(false);
    expect(isPendingListRecordable([item(1, '宽粉', 'abc')])).toBe(false);
    expect(isPendingListRecordable([item(1, '宽粉', '100'), item(2, '豆腐皮', '')])).toBe(false);
  });
});

describe('toBatchItems：清单 → 入账项', () => {
  it('解析克数并按同公式逐条预估热量', () => {
    const items = toBatchItems([item(1, '宽粉', '150', 200)]);
    expect(items).toEqual([
      { foodId: 1, name: '宽粉', grams: 150, servingUnit: '克', kcal: 300 }, // 200 × 150 / 100
    ]);
  });

  it('保留清单顺序，逐条热量各自独立', () => {
    const items = toBatchItems([item(1, '宽粉', '100', 200), item(2, '青菜', '50', 40)]);
    expect(items.map((entry) => entry.foodId)).toEqual([1, 2]);
    expect(items.map((entry) => entry.kcal)).toEqual([200, 20]);
  });

  it('非法克数不产生 NaN（解析为 0，交给服务端最终校验）', () => {
    const items = toBatchItems([item(1, '宽粉', '')]);
    expect(items[0]?.grams).toBe(0);
    expect(Number.isNaN(items[0]?.kcal ?? NaN)).toBe(false);
    expect(items[0]?.kcal).toBe(0);
  });
});
