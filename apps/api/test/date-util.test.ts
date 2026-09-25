import { describe, expect, it } from 'vitest';

import { isValidLocalDateKey, toDateKey } from '../src/common/utils/date.util';

/**
 * 日期工具回归（#6 / #7）。
 *
 * - `toDateKey`：把「日粒度」值归一为 `YYYY-MM-DD`，**Date 输入不再是崩溃点**
 *   （PG 的 `DateTime @db.Date` 下 Prisma 返回 Date，旧 `.slice(0, 10)` 会 TypeError）；
 * - `isValidLocalDateKey`：严格回环，拒绝 `2026-02-31` 这类「引擎会进位」的不存在日期。
 */

describe('toDateKey（#7 · PG date-only 兼容）', () => {
  it('字符串：直接取日期头部（SQLite 当前形态）', () => {
    expect(toDateKey('2026-09-23')).toBe('2026-09-23');
    // dbgenerated 写入的带时间戳形态 → 仍取日期
    expect(toDateKey('2026-09-23T10:00:00.000Z')).toBe('2026-09-23');
  });

  it('★ Date 输入不再崩溃，且按 UTC 分量取当日（@db.Date 语义）', () => {
    // date-only 列以 UTC 00:00 承载：无论本机时区为何，都应得到同一个日历日
    expect(toDateKey(new Date(Date.UTC(2026, 8, 23)))).toBe('2026-09-23');
    expect(toDateKey(new Date(Date.UTC(2026, 0, 5)))).toBe('2026-01-05'); // 补零
    // 当天末尾（UTC 23:59）仍是同一天
    expect(toDateKey(new Date(Date.UTC(2026, 0, 1, 23, 59, 59)))).toBe('2026-01-01');
  });

  it('随机时区无关性（本地分量不会把日期挪走一天）', () => {
    // 构造一个 UTC 午夜的 Date；用 UTC 分量取值保证：负时区（如 UTC-5）不会退回前一天
    const utcMidnight = new Date(Date.UTC(2026, 5, 15));
    expect(toDateKey(utcMidnight)).toBe('2026-06-15');
  });
});

describe('isValidLocalDateKey（#6 · 严格回环）', () => {
  it('真实存在的日期 → true（含闰年 2 月 29）', () => {
    expect(isValidLocalDateKey('2026-02-28')).toBe(true);
    expect(isValidLocalDateKey('2024-02-29')).toBe(true);
    expect(isValidLocalDateKey('2026-12-31')).toBe(true);
  });

  it('★ 不存在的日期 → false（2026-02-31 / 13 月 / 非闰年 2-29）', () => {
    expect(isValidLocalDateKey('2026-02-31')).toBe(false);
    expect(isValidLocalDateKey('2026-13-01')).toBe(false);
    expect(isValidLocalDateKey('2026-04-31')).toBe(false);
    expect(isValidLocalDateKey('2026-02-29')).toBe(false); // 2026 非闰年
  });

  it('格式不合规 / 非字符串 → false', () => {
    expect(isValidLocalDateKey('2026-2-3')).toBe(false); // 非严格两位
    expect(isValidLocalDateKey('today')).toBe(false);
    expect(isValidLocalDateKey(20260228)).toBe(false);
    expect(isValidLocalDateKey(undefined)).toBe(false);
  });
});
