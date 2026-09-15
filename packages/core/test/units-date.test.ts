import { describe, expect, it } from 'vitest';
import {
  ageFromBirthDate,
  gToKg,
  kcalToKj,
  kgToG,
  KJ_PER_KCAL,
  kjToKcal,
  lToMl,
  mlToL,
  toLocalDateKey,
} from '../src/index';

describe('单位换算（units/convert）', () => {
  it('kcal ↔ kJ 往返一致（1 kcal = 4.184 kJ）', () => {
    expect(kcalToKj(100)).toBeCloseTo(418.4, 6);
    expect(kjToKcal(418.4)).toBeCloseTo(100, 6);
    expect(kjToKcal(kcalToKj(1234))).toBeCloseTo(1234, 6);
    expect(KJ_PER_KCAL).toBeCloseTo(4.184, 6);
  });

  it('0 值边界', () => {
    expect(kcalToKj(0)).toBe(0);
    expect(kjToKcal(0)).toBe(0);
  });

  it('g ↔ kg 往返一致', () => {
    expect(kgToG(0.5)).toBeCloseTo(500, 6);
    expect(gToKg(500)).toBeCloseTo(0.5, 6);
    expect(kgToG(gToKg(750))).toBeCloseTo(750, 6);
  });

  it('ml ↔ l 往返一致', () => {
    expect(lToMl(1.5)).toBeCloseTo(1500, 6);
    expect(mlToL(1500)).toBeCloseTo(1.5, 6);
    expect(mlToL(lToMl(250))).toBeCloseTo(250, 6);
  });
});

describe('toLocalDateKey（本地时区 YYYY-MM-DD，K5）', () => {
  it('与本地 getFullYear/getMonth/getDate 拼接结果一致', () => {
    const date = new Date(2026, 8, 12, 23, 30, 0); // 2026-09-12 23:30 本地
    const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    expect(toLocalDateKey(date)).toBe(expected);
    expect(toLocalDateKey(date)).toBe('2026-09-12');
  });

  it('个位月份 / 日期补零', () => {
    expect(toLocalDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toLocalDateKey(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('不使用 UTC（跨 UTC 边界仍取本地日期）', () => {
    const local = new Date(2026, 0, 1, 0, 30, 0); // 本地 1 月 1 日凌晨
    expect(toLocalDateKey(local)).toBe('2026-01-01');
  });
});

describe('ageFromBirthDate（时间由参数注入）', () => {
  it('生日已过：按新一岁计', () => {
    expect(ageFromBirthDate('1995-06-15', new Date(2026, 8, 12))).toBe(31);
  });

  it('生日未到（同月但日期更早）减 1 岁', () => {
    expect(ageFromBirthDate('1995-06-15', new Date(2026, 5, 1))).toBe(30);
  });

  it('生日当天计为新一岁', () => {
    expect(ageFromBirthDate('1995-06-15', new Date(2026, 5, 15))).toBe(31);
  });

  it('跨月未过生日减 1 岁', () => {
    expect(ageFromBirthDate('2000-12-31', new Date(2026, 0, 1))).toBe(25);
  });

  it('接受 Date 类型的出生日期', () => {
    expect(ageFromBirthDate(new Date(1990, 0, 1), new Date(2026, 0, 1))).toBe(36);
  });

  it('非法日期字符串返回 NaN', () => {
    expect(Number.isNaN(ageFromBirthDate('not-a-date', new Date(2026, 0, 1)))).toBe(true);
  });
});
