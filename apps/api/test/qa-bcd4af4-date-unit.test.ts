import { describe, expect, it } from 'vitest';

import { toDateKey } from '../src/common/utils/date.util';

/**
 * QA 独立证伪（software-qa-engineer-4）—— C11 `toDateKey`（PG date-only 兼容）。
 *
 * 关注点：
 * - `Date` 输入**不崩溃**（旧 `.slice(0,10)` 会 TypeError）；
 * - 对 Prisma `@db.Date` 的**代表形态**（UTC 00:00）取值 = 正确日历日（不因本地时区回退一天）；
 * - 补零正确、跨月 / 跨年边界正确。
 */

describe('QA · toDateKey 独立证伪', () => {
  it('字符串输入 → 取日期头部（YYYY-MM-DD）', () => {
    expect(toDateKey('2026-09-23')).toBe('2026-09-23');
    expect(toDateKey('2026-09-23T10:00:00.000Z')).toBe('2026-09-23');
    expect(toDateKey('1999-01-01T00:00:00.000Z')).toBe('1999-01-01');
  });

  it('Date 输入（Prisma @db.Date 代表形态 = UTC 00:00）→ 不崩溃且取对当日', () => {
    // 关键：负时区（UTC-5）若用本地分量会把 UTC 午夜退回前一天；此处必须用 UTC 分量
    expect(toDateKey(new Date(Date.UTC(2026, 8, 23)))).toBe('2026-09-23');
    expect(toDateKey(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01');
    expect(toDateKey(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe('2026-12-31');
  });

  it('补零：单月 / 单日都补成两位', () => {
    expect(toDateKey(new Date(Date.UTC(2026, 0, 5)))).toBe('2026-01-05');
    expect(toDateKey(new Date(Date.UTC(2026, 8, 9)))).toBe('2026-09-09');
  });

  it('返回形态恒为 YYYY-MM-DD（正则）', () => {
    const pattern = /^\d{4}-\d{2}-\d{2}$/;
    expect(toDateKey('2026-02-28')).toMatch(pattern);
    expect(toDateKey(new Date(Date.UTC(2024, 1, 29)))).toMatch(pattern);
  });

  /**
   * 观察（非缺陷）：对「本地构造」的 Date（`new Date(y,m,d)` = 本地午夜），
   * UTC 分量在中东八区会回退一天。但生产里 `toDateKey` 只接收 DB 的 date-only 值
   * （SQLite string / PG `@db.Date` → UTC 00:00），不存在本地午夜输入。
   * 这里显式记录该边界，防止将来有人把本地 Date 传进来。
   */
  it('边界记录：本地午夜 Date 会用 UTC 分量（生产不产生该形态）', () => {
    const localMidnight = new Date(2026, 0, 5); // 本地 2026-01-05 00:00
    // 在 UTC+8 下其 UTC 分量为 2026-01-04；此处只断言「不抛错且形态合法」
    expect(toDateKey(localMidnight)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
