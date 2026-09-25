/**
 * 阶段回顾聚合单测（core/report/period.ts，R11.3 / AC-11.3.7）。
 *
 * 覆盖架构文档 §5.1 单测表的全部边界：
 * 空区间 / 单日（体重仅一条 → null）/ 365 天全量聚合 / 习惯并列截断 /
 * 未来日期裁剪 / 体重首末同一条 → null / 下降与上涨不产出评价语句 /
 * `distinctFoodCount` 与 `distinctFoodKeys` 同源（K16 防漂移）。
 */

import { describe, expect, it } from 'vitest';

import {
  PERIOD_DAY_OPTIONS,
  PERIOD_TOP_HABITS,
  distinctFoodKeys,
  resolvePeriodWindow,
  summarizePeriod,
  type PeriodFacts,
} from '../src/index';

const TODAY = '2026-09-23';

/** 造一份事实（默认全空，按需覆盖）。 */
function makeFacts(overrides: Partial<PeriodFacts> = {}): PeriodFacts {
  return {
    loggedDates: [],
    foodRows: [],
    mealEntryCount: 0,
    habitCounts: [],
    exercise: { sessions: 0, totalMinutes: 0 },
    weightFirst: null,
    weightLast: null,
    winCount: 0,
    ...overrides,
  };
}

describe('resolvePeriodWindow（区间解析）', () => {
  it('30 天档：含今天的 30 个自然日（from = to − 29）', () => {
    expect(resolvePeriodWindow(30, null, TODAY)).toEqual({ from: '2026-08-25', to: TODAY });
  });

  it('365 天档：含今天的 365 个自然日', () => {
    const window = resolvePeriodWindow(365, null, TODAY);
    expect(window).not.toBeNull();
    expect(window?.to).toBe(TODAY);
    // 365 天窗口跨度为 364 天
    expect(Math.round((Date.parse(TODAY) - Date.parse(window!.from)) / 86_400_000)).toBe(364);
  });

  it('days 非 30/365 → null（不允许隐式默认，缺省也由 API 层转 400）', () => {
    expect(resolvePeriodWindow(90, null, TODAY)).toBeNull();
    expect(resolvePeriodWindow(7, null, TODAY)).toBeNull();
    expect(resolvePeriodWindow(Number.NaN, null, TODAY)).toBeNull();
    for (const option of PERIOD_DAY_OPTIONS) {
      expect(resolvePeriodWindow(option, null, TODAY)).not.toBeNull();
    }
  });

  it('endDate 晚于今天 → 裁剪到今天（AC-11.3.7）', () => {
    expect(resolvePeriodWindow(30, '2026-12-31', TODAY)).toEqual({ from: '2026-08-25', to: TODAY });
  });

  it('endDate 合法且不晚于今天 → 按请求的结束日期', () => {
    expect(resolvePeriodWindow(30, '2026-09-01', TODAY)).toEqual({ from: '2026-08-03', to: '2026-09-01' });
  });

  it('★ endDate 是不存在的日期（2026-02-31）→ 不再静默进位，视同缺省用今天', () => {
    // 修复前：`new Date(2026, 1, 31)` 滚成 2026-03-03 被当成合法结束日期；
    // 修复后：回环校验判非法 → normalizeDateKey 返回 null → 按缺省（今天）处理。
    expect(resolvePeriodWindow(30, '2026-02-31', TODAY)).toEqual({ from: '2026-08-25', to: TODAY });
    expect(resolvePeriodWindow(30, '2026-13-01', TODAY)).toEqual({ from: '2026-08-25', to: TODAY });
  });

  it('endDate 合法（2 月末）→ 采纳；宽松月/日归一后仍合法', () => {
    expect(resolvePeriodWindow(30, '2026-02-28', TODAY)).toEqual({ from: '2026-01-30', to: '2026-02-28' });
    // 宽松到 1 位月/日：`2026-2-3` 归一为 `2026-02-03`（不应因严格化而被误杀）
    expect(resolvePeriodWindow(30, '2026-2-3', TODAY)).toEqual({ from: '2026-01-05', to: '2026-02-03' });
  });
});

describe('summarizePeriod（白名单聚合）', () => {
  it('空区间 → hasAnyData=false、loggedDays=0、weight=null、topHabits=[]', () => {
    const summary = summarizePeriod(makeFacts(), { from: '2026-08-25', to: TODAY });
    expect(summary.hasAnyData).toBe(false);
    expect(summary.loggedDays).toBe(0);
    expect(summary.distinctFoodCount).toBe(0);
    expect(summary.mealEntryCount).toBe(0);
    expect(summary.topHabits).toEqual([]);
    expect(summary.exercise).toEqual({ sessions: 0, totalMinutes: 0 });
    expect(summary.weight).toBeNull();
    expect(summary.winCount).toBe(0);
  });

  it('单日：loggedDays=1；体重仅一条 → weight=null（不是 0，AC-11.3.7）', () => {
    const summary = summarizePeriod(
      makeFacts({
        loggedDates: [TODAY],
        mealEntryCount: 2,
        weightFirst: { id: 11, date: TODAY, weightKg: 70.5 },
        weightLast: { id: 11, date: TODAY, weightKg: 70.5 },
      }),
      { from: '2026-08-25', to: TODAY },
    );
    expect(summary.hasAnyData).toBe(true);
    expect(summary.loggedDays).toBe(1);
    expect(summary.weight).toBeNull();
  });

  it('365 天档：全部指标正常聚合', () => {
    const summary = summarizePeriod(
      makeFacts({
        loggedDates: ['2025-09-24', '2026-01-01', '2026-09-23'],
        foodRows: [
          { foodItemId: 1, foodName: '米饭' },
          { customName: '米饭' },
          { foodItemId: 2, foodName: '番茄炒蛋' },
        ],
        mealEntryCount: 120,
        habitCounts: [{ habitId: 3, name: '喝水', count: 100 }],
        exercise: { sessions: 12, totalMinutes: 360 },
        weightFirst: { id: 1, date: '2025-09-24', weightKg: 72.4 },
        weightLast: { id: 9, date: '2026-09-23', weightKg: 70.1 },
        winCount: 5,
      }),
      { from: '2025-09-24', to: '2026-09-23' },
    );
    expect(summary.loggedDays).toBe(3);
    // 库内「米饭」与同名快加条目合并为 1 种（K16）
    expect(summary.distinctFoodCount).toBe(2);
    expect(summary.mealEntryCount).toBe(120);
    expect(summary.topHabits).toEqual([{ habitId: 3, name: '喝水', count: 100 }]);
    expect(summary.exercise).toEqual({ sessions: 12, totalMinutes: 360 });
    expect(summary.weight).toEqual({ startKg: 72.4, endKg: 70.1, deltaKg: -2.3 });
    expect(summary.winCount).toBe(5);
  });

  it('习惯并列第一（3 个同为 41 次）→ 只出 2 个，按 habitId 升序截断', () => {
    const summary = summarizePeriod(
      makeFacts({
        loggedDates: [TODAY],
        habitCounts: [
          { habitId: 7, name: '乙', count: 41 },
          { habitId: 2, name: '甲', count: 41 },
          { habitId: 5, name: '丙', count: 41 },
        ],
      }),
      { from: '2026-08-25', to: TODAY },
    );
    expect(summary.topHabits).toHaveLength(PERIOD_TOP_HABITS);
    expect(summary.topHabits.map((habit) => habit.habitId)).toEqual([2, 5]);
  });

  it('loggedDates 含未来日期 → 被裁剪，不计入 loggedDays', () => {
    const summary = summarizePeriod(
      makeFacts({ loggedDates: [TODAY, '2026-12-01', '2026-08-25'] }),
      { from: '2026-08-25', to: TODAY },
    );
    expect(summary.loggedDays).toBe(2);
  });

  it('体重首末为同一条（id 相同）→ weight=null（整块隐藏）', () => {
    const summary = summarizePeriod(
      makeFacts({
        loggedDates: [TODAY],
        weightFirst: { id: 3, date: '2026-08-25', weightKg: 70 },
        weightLast: { id: 3, date: TODAY, weightKg: 70 },
      }),
      { from: '2026-08-25', to: TODAY },
    );
    expect(summary.weight).toBeNull();
  });

  it('体重下降 / 上涨：deltaKg 保留 2 位小数，core 不产出任何评价语句', () => {
    const facts = makeFacts({
      loggedDates: ['2026-08-25', TODAY],
      weightFirst: { id: 1, date: '2026-08-25', weightKg: 70 },
      weightLast: { id: 2, date: TODAY, weightKg: 67.765 },
    });
    const down = summarizePeriod(facts, { from: '2026-08-25', to: TODAY });
    // 67.765 − 70 = −2.23499…（浮点）→ round2 归到 −2.23
    expect(down.weight).toEqual({ startKg: 70, endKg: 67.765, deltaKg: -2.23 });

    const up = summarizePeriod(
      { ...facts, weightFirst: { id: 1, date: '2026-08-25', weightKg: 67.7 }, weightLast: { id: 2, date: TODAY, weightKg: 68.1 } },
      { from: '2026-08-25', to: TODAY },
    );
    expect(up.weight).toEqual({ startKg: 67.7, endKg: 68.1, deltaKg: 0.4 });

    // 类型上只有数值，没有任何文本字段 —— 反评判在结构层封口
    expect(Object.keys(down.weight!)).toEqual(['startKg', 'endKg', 'deltaKg']);
  });

  it('distinctFoodCount 与 distinctFoodKeys 同源（K16 防漂移断言）', () => {
    const rows = [
      { foodItemId: 1, foodName: '米饭' },
      { customName: 'Milk Tea' },
      { foodItemId: 1, foodName: '米饭' },
      { foodItemId: null, customName: null },
    ];
    const summary = summarizePeriod(makeFacts({ loggedDates: [TODAY], foodRows: rows }), {
      from: '2026-08-25',
      to: TODAY,
    });
    expect(summary.distinctFoodCount).toBe(distinctFoodKeys(rows).count);
    expect(summary.distinctFoodCount).toBe(2);
  });
});
