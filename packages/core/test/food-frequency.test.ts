/**
 * 常吃榜排名测试（`food/frequency.ts`，R11.5）。
 *
 * 钉死契约（AC-11.5.9 / QR-1）：
 * - 计数口径是**出现天数**，同一天记 3 次只算 1 天（不是 3）；
 * - `dayCount < minDays` 被过滤，全部低于门槛时返回 `[]`（UI 整块隐藏）；
 * - 并列时 tie-break 稳定：最近出现日期靠前者在前，再并列按 `key` 升序（完全确定）；
 * - 自定义食物（`foodItemId` 为 `null`）同名按名称归一合并；
 * - 时间窗外的记录不计入；
 * - 空输入 → `[]`。
 */

import { describe, expect, it } from 'vitest';

import { FREQUENT_FOOD_DEFAULTS, rankFrequentFoods } from '../src/index';
import type { FrequentFoodRow } from '../src/index';

/** 造一行最小投影。 */
function row(
  loggedDate: string,
  customName: string | null,
  foodItemId: number | null = null,
  foodName: string | null = null,
): FrequentFoodRow {
  return { loggedDate, customName, foodItemId, foodName };
}

describe('rankFrequentFoods（R11.5 常吃榜）', () => {
  it('空输入 → 空数组（不是 null、不是缺字段）', () => {
    expect(rankFrequentFoods([])).toEqual([]);
  });

  it('同一天同一食物记 3 次 → dayCount === 1（不是 3）', () => {
    const rows = [
      row('2026-09-01', '奶茶'),
      row('2026-09-01', '奶茶'),
      row('2026-09-01', '奶茶'),
    ];
    // 只有 1 天 → 低于默认门槛 3，整块隐藏
    expect(rankFrequentFoods(rows)).toEqual([]);
    const relaxed = rankFrequentFoods(rows, { minDays: 1 });
    expect(relaxed).toHaveLength(1);
    expect(relaxed[0]?.dayCount).toBe(1);
  });

  it('跨 3 个不同日期 → dayCount === 3', () => {
    const rows = [row('2026-09-01', '米饭'), row('2026-09-02', '米饭'), row('2026-09-03', '米饭')];
    const ranked = rankFrequentFoods(rows);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.dayCount).toBe(3);
    expect(ranked[0]?.name).toBe('米饭');
    expect(ranked[0]?.lastLoggedDate).toBe('2026-09-03');
  });

  it('dayCount < minDays → 被过滤，不进榜', () => {
    const rows = [
      row('2026-09-01', '偶尔吃的蛋糕'),
      row('2026-09-02', '偶尔吃的蛋糕'),
      row('2026-09-01', '米饭'),
      row('2026-09-02', '米饭'),
      row('2026-09-03', '米饭'),
    ];
    const ranked = rankFrequentFoods(rows);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.name).toBe('米饭');
  });

  it('全部低于门槛 → []（UI 整块隐藏，不给「还不够」）', () => {
    const rows = [row('2026-09-01', 'A'), row('2026-09-02', 'B'), row('2026-09-03', 'C')];
    expect(rankFrequentFoods(rows)).toEqual([]);
  });

  it('频次并列 → 最近出现日期靠后者在前', () => {
    const rows = [
      row('2026-09-01', '苹果'),
      row('2026-09-02', '苹果'),
      row('2026-09-03', '苹果'),
      row('2026-09-05', '香蕉'),
      row('2026-09-06', '香蕉'),
      row('2026-09-07', '香蕉'),
    ];
    const ranked = rankFrequentFoods(rows);
    expect(ranked.map((item) => item.name)).toEqual(['香蕉', '苹果']);
  });

  it('天数与最近日期都并列 → 按 key 升序（确定性可复现）', () => {
    const rows = [
      row('2026-09-01', '橘子'),
      row('2026-09-02', '橘子'),
      row('2026-09-03', '橘子'),
      row('2026-09-01', '苹果'),
      row('2026-09-02', '苹果'),
      row('2026-09-03', '苹果'),
      row('2026-09-01', '香蕉'),
      row('2026-09-02', '香蕉'),
      row('2026-09-03', '香蕉'),
    ];
    const ranked = rankFrequentFoods(rows);
    // 全部 3 天、最近日期同为 09-03 → 按归一后的 key 升序（橘 < 苹 < 香）
    expect(ranked.map((item) => item.name)).toEqual(['橘子', '苹果', '香蕉']);
    // 顺序在重复运行中完全一致
    expect(rankFrequentFoods([...rows].reverse())).toEqual(ranked);
  });

  it('自定义食物（foodItemId 为 null）同名 → 按名称归一合并为一项', () => {
    const rows = [
      row('2026-09-01', '楼下麻辣烫'),
      row('2026-09-02', ' 楼下麻辣烫 '),
      row('2026-09-03', '楼下麻辣烫'),
    ];
    const ranked = rankFrequentFoods(rows);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.dayCount).toBe(3);
    expect(ranked[0]?.foodItemId).toBeNull();
  });

  it('库内条目与同名快加条目 → 合并为一项，并补齐 foodItemId', () => {
    const rows = [
      row('2026-09-01', null, 11, '番茄炒蛋'),
      row('2026-09-02', '番茄炒蛋', null, null),
      row('2026-09-03', null, 11, '番茄炒蛋'),
    ];
    const ranked = rankFrequentFoods(rows);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.dayCount).toBe(3);
    expect(ranked[0]?.foodItemId).toBe(11);
  });

  it('时间窗外的记录不计入（窗内外混合输入）', () => {
    // 默认窗口 90 天；窗外记录只有 2 天、窗内 3 天 → 合并应为 3 而不是 5
    const rows = [
      row('2025-01-01', '米饭'),
      row('2025-01-02', '米饭'),
      row('2026-09-01', '米饭'),
      row('2026-09-02', '米饭'),
      row('2026-09-03', '米饭'),
    ];
    const ranked = rankFrequentFoods(rows, { days: 90 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.dayCount).toBe(3);
  });

  it('limit 生效：只取前 N 项', () => {
    const rows: FrequentFoodRow[] = [];
    for (let day = 1; day <= 5; day += 1) {
      rows.push(row(`2026-09-0${day}`, `食物A`));
      rows.push(row(`2026-09-0${day}`, `食物B`));
      rows.push(row(`2026-09-0${day}`, `食物C`));
      rows.push(row(`2026-09-0${day}`, `食物D`));
    }
    expect(rankFrequentFoods(rows, { limit: 2 })).toHaveLength(2);
  });

  it('默认口径常量（AC-11.5.1 / AC-11.5.2）', () => {
    expect(FREQUENT_FOOD_DEFAULTS).toEqual({ days: 90, limit: 12, minDays: 3 });
  });

  it('脏数据（无 loggedDate / 无身份）被忽略，不抛错', () => {
    const rows = [
      row('2026-09-01', null),
      { loggedDate: '', customName: '米饭' } as FrequentFoodRow,
      row('2026-09-01', '米饭'),
      row('2026-09-02', '米饭'),
      row('2026-09-03', '米饭'),
    ];
    const ranked = rankFrequentFoods(rows);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.name).toBe('米饭');
  });
});
