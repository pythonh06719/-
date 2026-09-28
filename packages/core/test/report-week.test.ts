/**
 * 周报窗口测试（B2 · 可回看历史周）—— `core/report/week.ts`。
 *
 * 钉死四件事：
 * ① 周边界 = 「最后一天往前 7 天」的闭区间，与后端 `from = to - 6` 同口径；
 * ② 未来禁用：晚于今天的 `endDate` 一律裁剪到今天，往后翻不越过今天；
 * ③ 往前翻**不设硬上限**（后端支持任意日期）；
 * ④ 空周判定：只有「真的一条记录都没有」才算空，避免把有数据的周误判成空态。
 */

import { describe, expect, it } from 'vitest';
import {
  WEEK_WINDOW_DAYS,
  canShiftWeekForward,
  hasAnyWeeklyRecord,
  resolveWeekWindow,
  shiftWeekEndDate,
  weeksBeforeToday,
} from '../src/report/week';
import { diffLocalDateKeys, normalizeLocalDateKey, shiftLocalDateKey } from '../src/date/daykey';

const TODAY = '2026-09-23'; // 周三

describe('日期键工具（下沉到 date/daykey.ts）', () => {
  it('normalizeLocalDateKey：1 位月/日补齐两位，不存在的日期判非法', () => {
    expect(normalizeLocalDateKey('2026-2-3')).toBe('2026-02-03');
    expect(normalizeLocalDateKey('2026-02-03')).toBe('2026-02-03');
    expect(normalizeLocalDateKey('2026-02-31')).toBeNull(); // 2 月没有 31 日
    expect(normalizeLocalDateKey('2026-13-01')).toBeNull();
    expect(normalizeLocalDateKey('')).toBeNull();
    expect(normalizeLocalDateKey(null)).toBeNull();
    expect(normalizeLocalDateKey(undefined)).toBeNull();
  });

  it('shiftLocalDateKey：跨月 / 跨年加减，形态不符原样返回', () => {
    expect(shiftLocalDateKey('2026-09-23', -7)).toBe('2026-09-16');
    expect(shiftLocalDateKey('2026-09-03', -7)).toBe('2026-08-27'); // 跨月
    expect(shiftLocalDateKey('2026-01-02', -7)).toBe('2025-12-26'); // 跨年
    expect(shiftLocalDateKey('2026-02-28', 1)).toBe('2026-03-01'); // 平年
    expect(shiftLocalDateKey('2024-02-28', 1)).toBe('2024-02-29'); // 闰年
    expect(shiftLocalDateKey('2026/09/23', 1)).toBe('2026/09/23');
  });

  it('diffLocalDateKeys：b − a 的日历天数；非法输入返回 0', () => {
    expect(diffLocalDateKeys('2026-09-16', '2026-09-23')).toBe(7);
    expect(diffLocalDateKeys('2026-09-23', '2026-09-23')).toBe(0);
    expect(diffLocalDateKeys('2025-12-26', '2026-01-02')).toBe(7);
    expect(diffLocalDateKeys('bad', '2026-09-23')).toBe(0);
    expect(diffLocalDateKeys('2026-09-23', 'bad')).toBe(0);
  });
});

describe('resolveWeekWindow（周边界口径）', () => {
  it('缺省 / 非法 endDate → 用今天，窗口 = 今天往前 7 天', () => {
    expect(resolveWeekWindow(null, TODAY)).toEqual({ from: '2026-09-17', to: '2026-09-23' });
    expect(resolveWeekWindow('', TODAY)).toEqual({ from: '2026-09-17', to: '2026-09-23' });
    expect(resolveWeekWindow('not-a-date', TODAY)).toEqual({ from: '2026-09-17', to: '2026-09-23' });
  });

  it('窗口恒为 7 天闭区间（末日 = endDate）', () => {
    const window = resolveWeekWindow('2026-03-01', TODAY);
    expect(window).toEqual({ from: '2026-02-23', to: '2026-03-01' });
    expect(diffLocalDateKeys(window!.from, window!.to)).toBe(WEEK_WINDOW_DAYS - 1);
  });

  it('未来 endDate → 裁剪到今天（未来禁用）', () => {
    expect(resolveWeekWindow('2026-10-01', TODAY)).toEqual({ from: '2026-09-17', to: '2026-09-23' });
    expect(resolveWeekWindow('2027-01-01', TODAY)).toEqual({ from: '2026-09-17', to: '2026-09-23' });
  });

  it('往前翻不设硬上限：一年前、三年前照常解析', () => {
    expect(resolveWeekWindow('2025-09-23', TODAY)).toEqual({ from: '2025-09-17', to: '2025-09-23' });
    expect(resolveWeekWindow('2023-01-01', TODAY)).toEqual({ from: '2022-12-26', to: '2023-01-01' });
  });

  it('todayKey 非法 → null（不猜日期）', () => {
    expect(resolveWeekWindow('2026-09-23', 'yesterday')).toBeNull();
  });
});

describe('shiftWeekEndDate / canShiftWeekForward（翻周）', () => {
  it('往前翻一周：末日 −7；往后翻一周：末日 +7', () => {
    expect(shiftWeekEndDate('2026-09-23', -1, TODAY)).toBe('2026-09-16');
    expect(shiftWeekEndDate('2026-09-16', 1, TODAY)).toBe('2026-09-23');
    expect(shiftWeekEndDate('2026-09-23', -2, TODAY)).toBe('2026-09-09');
  });

  it('往后翻不越过今天（未来禁用，双保险）', () => {
    // 即便调用方忘记判禁用，也不会返回未来日期
    expect(shiftWeekEndDate('2026-09-23', 1, TODAY)).toBe('2026-09-23');
    expect(shiftWeekEndDate('2026-09-20', 1, TODAY)).toBe('2026-09-23');
  });

  it('canShiftWeekForward：只有「再往后一周仍在今天之前」才允许', () => {
    expect(canShiftWeekForward('2026-09-16', TODAY)).toBe(true);
    expect(canShiftWeekForward('2026-09-17', TODAY)).toBe(false); // +7 = 09-24 > 今天
    expect(canShiftWeekForward('2026-09-23', TODAY)).toBe(false); // 本周不能再往后
  });

  it('往前翻不设上限：连翻 10 周仍在解析范围内', () => {
    let cursor = TODAY;
    for (let week = 0; week < 10; week += 1) {
      cursor = shiftWeekEndDate(cursor, -1, TODAY);
    }
    expect(cursor).toBe('2026-07-15');
    expect(resolveWeekWindow(cursor, TODAY)).toEqual({ from: '2026-07-09', to: '2026-07-15' });
  });

  it('非法入参不产生 NaN / 未来日期', () => {
    expect(shiftWeekEndDate('garbage', -1, TODAY)).toBe('2026-09-16');
    expect(shiftWeekEndDate('2026-09-23', Number.NaN, TODAY)).toBe('2026-09-23');
    expect(canShiftWeekForward('garbage', 'bad-today')).toBe(false);
  });
});

describe('weeksBeforeToday（「几周前」）', () => {
  it('今天 = 本周（0）', () => {
    expect(weeksBeforeToday('2026-09-23', TODAY)).toBe(0);
  });

  it('过去 1~7 天 = 上一周（1）', () => {
    expect(weeksBeforeToday('2026-09-22', TODAY)).toBe(1);
    expect(weeksBeforeToday('2026-09-17', TODAY)).toBe(1);
  });

  it('再往前按 7 天一档递增', () => {
    expect(weeksBeforeToday('2026-09-16', TODAY)).toBe(1); // 恰好 −7
    expect(weeksBeforeToday('2026-09-10', TODAY)).toBe(2);
    expect(weeksBeforeToday('2026-09-09', TODAY)).toBe(2); // 恰好 −14
    expect(weeksBeforeToday('2026-08-01', TODAY)).toBe(8);
  });

  it('未来日期 / 非法输入 → 0（按本周处理，不出现负数）', () => {
    expect(weeksBeforeToday('2026-10-01', TODAY)).toBe(0);
    expect(weeksBeforeToday('garbage', TODAY)).toBe(0);
    expect(weeksBeforeToday('2026-09-23', 'bad-today')).toBe(0);
  });
});

describe('hasAnyWeeklyRecord（空周判定）', () => {
  it('全为 0 / 空 → 判为无记录（UI 走中性空态，不渲染 0 值墙）', () => {
    expect(hasAnyWeeklyRecord({ avgIntakeKcal: 0, totalExerciseKcal: 0, days: [] })).toBe(false);
    expect(
      hasAnyWeeklyRecord({
        avgIntakeKcal: 0,
        totalExerciseKcal: 0,
        distinctFoodCount: 0,
        weightChangeKg: null,
        days: Array.from({ length: 7 }, () => ({
          intakeKcal: 0,
          exerciseKcal: 0,
          waterMl: 0,
          habitsDone: 0,
        })),
      }),
    ).toBe(false);
  });

  it('任一维度有记录 → 不算空（避免误判成空态）', () => {
    expect(hasAnyWeeklyRecord({ avgIntakeKcal: 1300 })).toBe(true);
    expect(hasAnyWeeklyRecord({ totalExerciseKcal: 200 })).toBe(true);
    expect(hasAnyWeeklyRecord({ distinctFoodCount: 3 })).toBe(true);
    expect(hasAnyWeeklyRecord({ weightChangeKg: -0.4 })).toBe(true);
    expect(hasAnyWeeklyRecord({ days: [{ waterMl: 1500 }] })).toBe(true);
    expect(hasAnyWeeklyRecord({ days: [{ habitsDone: 1 }] })).toBe(true);
    expect(hasAnyWeeklyRecord({ days: [{ exerciseKcal: 10 }] })).toBe(true);
  });

  it('缺字段 / null / 非数组 → 不抛错，按无记录处理', () => {
    expect(hasAnyWeeklyRecord(null)).toBe(false);
    expect(hasAnyWeeklyRecord(undefined)).toBe(false);
    expect(hasAnyWeeklyRecord({})).toBe(false);
    expect(hasAnyWeeklyRecord({ days: null })).toBe(false);
    expect(hasAnyWeeklyRecord({ avgIntakeKcal: null, days: [null as never] })).toBe(false);
    expect(hasAnyWeeklyRecord({ avgIntakeKcal: Number.NaN })).toBe(false);
    expect(hasAnyWeeklyRecord({ avgIntakeKcal: -5 })).toBe(false);
  });
});
