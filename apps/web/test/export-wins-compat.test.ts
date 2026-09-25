/**
 * 导出 wins 段兼容读法测试（R11.4 / QR-6，core/export/payload.ts + lib/csv.ts）。
 *
 * 版本语义（K25）：`EXPORT_SCHEMA_VERSION` 1 → 2，只增不减；
 * **v1 备份文件没有 `wins` 顶层键，读取必须返回 `[]` 而不是抛错** ——
 * 导入 / 回看不因版本差而失败。
 */

import { describe, expect, it } from 'vitest';
import { EXPORT_SCHEMA_VERSION, EXPORT_APP_ID } from '@qsh/shared-types';
import { EXPORT_SCHEMA_VERSION_MIN_WINS, readExportWins } from '@qsh/core';
import { createEmptyExportPayload } from '@/lib/csv';

/** 模拟一份 v1 备份（schemaVersion 1，没有 wins 键）。 */
function v1Payload(): Record<string, unknown> {
  return {
    meta: { app: EXPORT_APP_ID, schemaVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z' },
    profile: {},
    goals: {},
    weights: [],
    meals: [],
    exercises: [],
    habits: [],
    water: [],
    settings: {},
  };
}

describe('readExportWins（v1 → v2 兼容）', () => {
  it('v1 备份没有 wins 键 → 返回 [] 且不抛错（QR-6）', () => {
    const payload = v1Payload();
    expect(() => readExportWins(payload)).not.toThrow();
    expect(readExportWins(payload)).toEqual([]);
  });

  it('v2 备份的 wins 行逐条读出（date + text）', () => {
    const payload = {
      ...v1Payload(),
      meta: { app: EXPORT_APP_ID, schemaVersion: 2, exportedAt: '2026-09-23T00:00:00.000Z' },
      wins: [
        { date: '2026-09-22', text: '爬楼不喘了' },
        { date: '2026-09-23', text: '裤子松了' },
      ],
    };
    expect(readExportWins(payload)).toEqual([
      { date: '2026-09-22', text: '爬楼不喘了' },
      { date: '2026-09-23', text: '裤子松了' },
    ]);
  });

  it('单条脏数据逐条过滤，不因一行坏数据丢整批', () => {
    const payload = {
      wins: [
        { date: '2026-09-22', text: '好的一条' },
        { date: 20260923, text: 'date 不是字符串' },
        { date: '2026-09-24', text: null },
        null,
        '字符串不是对象',
        { date: '2026-09-25', text: '另一条好的' },
      ],
    };
    expect(readExportWins(payload)).toEqual([
      { date: '2026-09-22', text: '好的一条' },
      { date: '2026-09-25', text: '另一条好的' },
    ]);
  });

  it('wins 不是数组 / raw 非对象 → 一律 []，绝不抛错', () => {
    expect(readExportWins({ wins: '不是数组' })).toEqual([]);
    expect(readExportWins({ wins: {} })).toEqual([]);
    expect(readExportWins(null)).toEqual([]);
    expect(readExportWins(undefined)).toEqual([]);
    expect(readExportWins([1, 2, 3])).toEqual([]);
    expect(readExportWins('字符串')).toEqual([]);
    expect(readExportWins(42)).toEqual([]);
  });

  it('版本常量：wins 自 schemaVersion 2 起存在，与 shared-types 的当前版本一致（K25）', () => {
    expect(EXPORT_SCHEMA_VERSION).toBe(EXPORT_SCHEMA_VERSION_MIN_WINS);
    expect(EXPORT_SCHEMA_VERSION).toBe(2);
  });
});

describe('createEmptyExportPayload（web 导出骨架）', () => {
  it('骨架带 wins: []（v2 必填顶层键），且 readExportWins 能读回', () => {
    const payload = createEmptyExportPayload('2026-09-23T00:00:00.000Z');
    expect(payload.meta.schemaVersion).toBe(2);
    expect(payload.wins).toEqual([]);

    // 骨架 + 用户补两条 wins → 完整 v2 payload 可被同一读法读回
    const full = {
      ...payload,
      wins: [{ date: '2026-09-23', text: '今天心情不错' }],
    };
    expect(readExportWins(full)).toEqual([{ date: '2026-09-23', text: '今天心情不错' }]);
  });
});
