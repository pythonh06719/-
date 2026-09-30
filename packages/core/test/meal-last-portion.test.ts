/**
 * 「上次份量记忆」口径（core/meal/last-portion.ts）测试 —— D-1 的门禁。
 *
 * 钉死四件事：
 * ① **有效份量判定**：`grams` 为正 → 有效；`grams` 空但「单位 + 数量」齐全 → 有效；
 *    三者皆空（快加卡 / 空白记录的形态）→ **无效**（绝不能把用户上次吃的量抹成 0）；
 * ② **优先克数**：有克数时直接用克数，单位取历史里的 `servingUnit`，缺省 `克`；
 * ③ **单位 × 数量兜底**：没有克数时借食物库单位表换算；命中不了 → `null`（交给默认份量）；
 * ④ **脏输入不抛错**：`null` / `undefined` / `NaN` / `0` / 负数 → `null`，绝不产生 NaN。
 *
 * ⚠️ 这是「哪条历史有效」与「怎么折成默认份量」的**单一真源**：前后端任一处改了规则，
 * 这里的用例必须先红（NFR-11：同一件事只能有一个口径）。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PORTION_UNIT,
  hasUsablePortion,
  resolveLastPortionServing,
} from '../src/meal/last-portion';

describe('hasUsablePortion：哪条历史算「有份量」', () => {
  it('有正克数 → 有效', () => {
    expect(hasUsablePortion({ grams: 300, servingUnit: null, servingQty: null })).toBe(true);
  });

  it('没有克数、但有「单位 + 数量」→ 有效', () => {
    expect(hasUsablePortion({ grams: null, servingUnit: '碗', servingQty: 2 })).toBe(true);
  });

  it('★ 快加卡 / 空白记录（三者皆空）→ 无效（不能当成「上次份量」）', () => {
    expect(hasUsablePortion({ grams: null, servingUnit: null, servingQty: null })).toBe(false);
  });

  it('只有单位、没有数量 → 无效（凑不出量）', () => {
    expect(hasUsablePortion({ grams: null, servingUnit: '碗', servingQty: null })).toBe(false);
  });

  it('只有空白单位 + 数量 → 无效', () => {
    expect(hasUsablePortion({ grams: null, servingUnit: '   ', servingQty: 2 })).toBe(false);
  });

  it('null / undefined → 无效（不抛错）', () => {
    expect(hasUsablePortion(null)).toBe(false);
    expect(hasUsablePortion(undefined)).toBe(false);
  });

  it('0 / 负数 / NaN 克数按「没填」处理', () => {
    expect(hasUsablePortion({ grams: 0 })).toBe(false);
    expect(hasUsablePortion({ grams: -50 })).toBe(false);
    expect(hasUsablePortion({ grams: Number.NaN })).toBe(false);
    expect(hasUsablePortion({ grams: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('resolveLastPortionServing：折成默认份量', () => {
  it('有克数 → 直接用它，单位取历史的 servingUnit', () => {
    expect(resolveLastPortionServing({ grams: 300, servingUnit: '碗', servingQty: 2 })).toEqual({
      unit: '碗',
      grams: 300,
    });
  });

  it('有克数但没有单位 → 单位回落「克」', () => {
    expect(resolveLastPortionServing({ grams: 180, servingUnit: null })).toEqual({
      unit: DEFAULT_PORTION_UNIT,
      grams: 180,
    });
  });

  it('克数保留 1 位小数（与 round1 同口径）', () => {
    expect(resolveLastPortionServing({ grams: 137.46 })).toEqual({
      unit: DEFAULT_PORTION_UNIT,
      grams: 137.5,
    });
  });

  it('★ 没有克数、有「单位 + 数量」→ 借食物库单位表换算', () => {
    const result = resolveLastPortionServing(
      { grams: null, servingUnit: '碗', servingQty: 2 },
      { servingUnits: [{ unit: '碗', grams: 150 }] },
    );
    expect(result).toEqual({ unit: '碗', grams: 300 });
  });

  it('★ 单位在食物库里命中不了 → null（交给默认份量，行为不变）', () => {
    expect(
      resolveLastPortionServing(
        { grams: null, servingUnit: '碗', servingQty: 2 },
        { servingUnits: [{ unit: '份', grams: 150 }] },
      ),
    ).toBeNull();
  });

  it('没有食物单位表时，缺克数 → null', () => {
    expect(resolveLastPortionServing({ grams: null, servingUnit: '碗', servingQty: 2 })).toBeNull();
  });

  it('无效历史（三者皆空）→ null（回落默认份量的入口）', () => {
    expect(resolveLastPortionServing({ grams: null, servingUnit: null, servingQty: null })).toBeNull();
  });

  it('null / undefined → null（不抛错）', () => {
    expect(resolveLastPortionServing(null)).toBeNull();
    expect(resolveLastPortionServing(undefined)).toBeNull();
  });

  it('0 / 负数克数 → null（不把 0 当份量）', () => {
    expect(resolveLastPortionServing({ grams: 0 })).toBeNull();
    expect(resolveLastPortionServing({ grams: -1, servingUnit: '碗', servingQty: 2 })).toBeNull();
  });
});
