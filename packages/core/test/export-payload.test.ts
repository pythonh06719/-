/**
 * 导出 payload 兼容读法单测（core/export/payload.ts，R11.4 / QR-6）。
 *
 * v1 备份文件（无 `wins` 键）读取不报错；脏输入逐条过滤；绝不抛错。
 */

import { describe, expect, it } from 'vitest';

import { EXPORT_SCHEMA_VERSION_MIN_WINS, readExportWins } from '../src/index';

describe('readExportWins（v1 → v2 兼容读）', () => {
  it('v1 payload（无 wins 键）→ []，不抛错（QR-6）', () => {
    const v1 = {
      meta: { app: 'qingshenghuo', schemaVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z' },
      weights: [],
    };
    expect(readExportWins(v1)).toEqual([]);
  });

  it('v2 payload → 逐条返回', () => {
    const v2 = {
      meta: { schemaVersion: 2 },
      wins: [
        { date: '2026-09-23', text: '今天爬楼没那么喘了' },
        { date: '2026-09-23', text: '裤子松了一圈' },
      ],
    };
    expect(readExportWins(v2)).toEqual([
      { date: '2026-09-23', text: '今天爬楼没那么喘了' },
      { date: '2026-09-23', text: '裤子松了一圈' },
    ]);
  });

  it('wins: null / wins: 字符串 / wins: 对象 → []', () => {
    expect(readExportWins({ wins: null })).toEqual([]);
    expect(readExportWins({ wins: 'x' })).toEqual([]);
    expect(readExportWins({ wins: { date: '2026-09-23', text: 'x' } })).toEqual([]);
  });

  it('元素缺 text / 缺 date / 非对象 → 该条被过滤，不丢整批', () => {
    const payload = {
      wins: [
        { date: '2026-09-23', text: '好的这条' },
        { date: '2026-09-23' },
        { text: '缺日期' },
        null,
        '字符串元素',
        { date: '2026-09-24', text: '好的那条' },
      ],
    };
    expect(readExportWins(payload)).toEqual([
      { date: '2026-09-23', text: '好的这条' },
      { date: '2026-09-24', text: '好的那条' },
    ]);
  });

  it('raw = null / 数组 / 字符串 / 数字 → []，绝不抛错', () => {
    expect(readExportWins(null)).toEqual([]);
    expect(readExportWins(undefined)).toEqual([]);
    expect(readExportWins(['wins'])).toEqual([]);
    expect(readExportWins('str')).toEqual([]);
    expect(readExportWins(42)).toEqual([]);
  });

  it('版本常量：wins 自 schemaVersion 2 起存在', () => {
    expect(EXPORT_SCHEMA_VERSION_MIN_WINS).toBe(2);
  });
});
