/**
 * 导出 payload 兼容读法单测（core/export/payload.ts，R11.4 / QR-6）。
 *
 * v1 备份文件（无 `wins` 键）读取不报错；脏输入逐条过滤；绝不抛错。
 */

import { describe, expect, it } from 'vitest';

import {
  EXPORT_SCHEMA_VERSION_MIN_WINS,
  MAX_EXPORT_PAYLOAD_BYTES,
  parseExportPayload,
  readExportWins,
} from '../src/index';

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

function validPayload(schemaVersion: 1 | 2 = 2): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    meta: { app: 'qingshenghuo', schemaVersion, exportedAt: '2026-09-12T00:00:00.000Z' },
    profile: {
      gender: 'female',
      birthDate: '1990-01-01',
      heightCm: 165,
      activityLevel: 'light',
      dietaryPreference: ['清淡'],
      conditions: [],
    },
    goals: {
      targetWeightKg: 55,
      targetWeeks: 12,
      macroRatio: { protein: 25, fat: 25, carb: 50 },
    },
    weights: [{ date: '2026-09-01', weightKg: 60, note: '' }],
    meals: [
      {
        date: '2026-09-02',
        mealType: 'lunch',
        items: [
          { name: '番茄炒蛋', grams: 200, kcal: 180, proteinG: 8, fatG: 10, carbG: 12 },
          { name: '米饭', grams: 100, kcal: 116, proteinG: 2.6, fatG: 0.3, carbG: 25.9 },
        ],
      },
    ],
    exercises: [{ date: '2026-09-03', type: 'walking_brisk', met: 5, minutes: 30, kcalBurned: 150 }],
    habits: [{ date: '2026-09-04', habitId: 'early_sleep', done: true }],
    water: [{ date: '2026-09-05', ml: 250 }],
    settings: { unit: 'kcal', darkMode: false, fastingEnabled: false },
  };
  if (schemaVersion === 2) {
    payload.wins = [{ date: '2026-09-06', text: '今天精神很好' }];
  }
  return payload;
}

describe('parseExportPayload（JSON 备份恢复）', () => {
  it('v1：没有 wins 时按空数组读取，并生成 6 类统计与日期跨度', () => {
    const result = parseExportPayload(JSON.stringify(validPayload(1)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.meta.schemaVersion).toBe(1);
    expect(result.payload.wins).toEqual([]);
    expect(result.summary).toEqual({
      counts: { weights: 1, meals: 2, exercises: 1, habits: 1, water: 1, wins: 0 },
      dateRange: { from: '2026-09-01', to: '2026-09-05' },
    });
  });

  it('v2：保留 wins；带 BOM 的 JSON 也能读取', () => {
    const result = parseExportPayload(`\uFEFF${JSON.stringify(validPayload(2))}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.wins).toEqual([{ date: '2026-09-06', text: '今天精神很好' }]);
    expect(result.summary.counts.wins).toBe(1);
    expect(result.summary.dateRange).toEqual({ from: '2026-09-01', to: '2026-09-06' });
  });

  it('v2 的 wins 若不是数组，沿用 readExportWins 语义按空数组处理', () => {
    const payload = validPayload(2);
    payload.wins = 'not-an-array';
    const result = parseExportPayload(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.wins).toEqual([]);
  });

  it('脏数据：已知实体字段不合契约时返回明确形状原因，不抛异常', () => {
    const payload = validPayload(2);
    payload.weights = [{ date: '2026-02-31', weightKg: 60, note: '' }];
    const result = parseExportPayload(JSON.stringify(payload));
    expect(result).toEqual({
      ok: false,
      error: { code: 'EXPORT_SHAPE_MISMATCH', message: '这份内容与轻生活备份的格式不一致' },
    });
  });

  it('超长输入：在 JSON 解析前返回明确大小原因', () => {
    const result = parseExportPayload('x'.repeat(MAX_EXPORT_PAYLOAD_BYTES + 1));
    expect(result).toEqual({
      ok: false,
      error: { code: 'EXPORT_TOO_LARGE', message: '这个文件内容太多，这次先不读取' },
    });
  });

  it('非对象与不能解析的 JSON：分别返回明确原因', () => {
    expect(parseExportPayload('[]')).toEqual({
      ok: false,
      error: { code: 'EXPORT_SHAPE_MISMATCH', message: '这份内容与轻生活备份的格式不一致' },
    });
    expect(parseExportPayload('{')).toEqual({
      ok: false,
      error: {
        code: 'EXPORT_JSON_UNREADABLE',
        message: '这次没能读出备份内容，请选择轻生活导出的 JSON 文件',
      },
    });
  });

  it('更高结构版本给出可区分的版本原因', () => {
    const payload = validPayload(2);
    payload.meta = { app: 'qingshenghuo', schemaVersion: 3, exportedAt: '2026-09-12T00:00:00.000Z' };
    const result = parseExportPayload(payload);
    expect(result).toEqual({
      ok: false,
      error: { code: 'EXPORT_VERSION_UNSUPPORTED', message: '这份备份来自较新的版本，当前暂时不能读取' },
    });
  });

  it('空记录备份的日期跨度为 null', () => {
    const payload = validPayload(2);
    for (const key of ['weights', 'meals', 'exercises', 'habits', 'water', 'wins']) {
      payload[key] = [];
    }
    const result = parseExportPayload(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.dateRange).toBeNull();
  });
});
