import { describe, expect, it } from 'vitest';
import { CSV_BOM, CSV_FILE_NAMES } from '@qsh/shared-types';
import {
  buildCsvFile,
  escapeCsvField,
  parseWeightCsv,
  serializeCsv,
  serializeExportBundle,
  withBom,
  createEmptyExportPayload,
} from '@/lib/csv';

/**
 * CSV 导出 / 导入序列化纯函数单测（T04 DoD 第 4 项 / K11 / §9）。
 *
 * 覆盖：**BOM**、表头、**转义逗号 / 引号 / 中文**、JSON 打包、导入非法行汇总。
 */
describe('escapeCsvField', () => {
  it('普通中文 / 数字 / 空值', () => {
    expect(escapeCsvField('番茄炒蛋')).toBe('番茄炒蛋');
    expect(escapeCsvField(1200)).toBe('1200');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('含逗号 → 双引号包裹', () => {
    expect(escapeCsvField('含,逗号')).toBe('"含,逗号"');
  });

  it('含双引号 → 引号翻倍并包裹', () => {
    expect(escapeCsvField('他说"好"')).toBe('"他说""好"""');
  });

  it('含换行 → 包裹保留换行', () => {
    expect(escapeCsvField('第一行\n第二行')).toBe('"第一行\n第二行"');
  });
});

describe('serializeCsv / withBom / buildCsvFile', () => {
  it('首行表头 + 逐行序列化', () => {
    const csv = serializeCsv(['date', 'weightKg', 'note'], [
      { date: '2026-09-01', weightKg: 60, note: '很好' },
      { date: '2026-09-02', weightKg: 59.8, note: '聚餐, 晚睡' },
    ]);
    expect(csv.split('\r\n')[0]).toBe('date,weightKg,note');
    expect(csv).toContain('2026-09-01,60,很好');
    expect(csv).toContain('"聚餐, 晚睡"');
  });

  it('withBom 前置 U+FEFF', () => {
    expect(withBom('a,b')).toBe(`${CSV_BOM}a,b`);
    expect(withBom('x').charCodeAt(0)).toBe(0xfeff);
  });

  it('buildCsvFile 统一带 BOM 且标注 withBom', () => {
    const file = buildCsvFile(CSV_FILE_NAMES.weights, ['date', 'weightKg'], [
      { date: '2026-09-01', weightKg: 60 },
    ]);
    expect(file.fileName).toBe('weights.csv');
    expect(file.withBom).toBe(true);
    expect(file.content.startsWith(CSV_BOM)).toBe(true);
    expect(file.content).toContain('date,weightKg');
  });
});

describe('serializeExportBundle', () => {
  it('打包 7 个文件：data.json + 6 个 CSV（含 wins.csv，B4）', () => {
    const payload = createEmptyExportPayload('2026-09-12T00:00:00.000Z');
    payload.weights = [{ date: '2026-09-01', weightKg: 60, note: '' }];
    payload.meals = [
      {
        date: '2026-09-01',
        mealType: 'lunch',
        items: [{ name: '番茄炒蛋', grams: 300, kcal: 180, proteinG: 8, fatG: 12, carbG: 8 }],
      },
    ];
    payload.wins = [
      { date: '2026-09-01', text: '爬楼不喘了' },
      { date: '2026-09-02', text: '今天走了 8000 步, 还喝了水' },
      { date: '2026-09-03', text: '他说"可以"' },
    ];

    const bundle = serializeExportBundle(payload);
    expect(bundle.files).toHaveLength(7);
    expect(bundle.files[0]?.fileName).toBe('data.json');
    expect(bundle.files[0]?.withBom).toBe(false);

    const weightsCsv = bundle.files.find((file) => file.fileName === 'weights.csv');
    expect(weightsCsv?.content.startsWith(CSV_BOM)).toBe(true);
    expect(weightsCsv?.content).toContain('date,weightKg,note');

    const mealsCsv = bundle.files.find((file) => file.fileName === 'meals.csv');
    expect(mealsCsv?.content).toContain('date,mealType,name,grams,kcal,proteinG,fatG,carbG');
    expect(mealsCsv?.content).toContain('番茄炒蛋');

    const winsCsv = bundle.files.find((file) => file.fileName === CSV_FILE_NAMES.wins);
    expect(winsCsv?.withBom).toBe(true);
    expect(winsCsv?.content.startsWith(CSV_BOM)).toBe(true);
    // 首行是表头（去掉 BOM 后比较）
    expect(winsCsv?.content.slice(CSV_BOM.length).split('\r\n')[0]).toBe('date,text');
    expect(winsCsv?.content).toContain('2026-09-01,爬楼不喘了');
    // RFC 4180：逗号 → 双引号包裹
    expect(winsCsv?.content).toContain('"今天走了 8000 步, 还喝了水"');
    // RFC 4180：双引号 → 翻倍并包裹
    expect(winsCsv?.content).toContain('"他说""可以"""');
  });

  it('wins.csv 内容逐字照录，不做截断或改写', () => {
    const payload = createEmptyExportPayload('2026-09-12T00:00:00.000Z');
    payload.wins = [
      { date: '2026-09-05', text: '第一行\n第二行' },
      { date: '2026-09-06', text: '' },
    ];
    const bundle = serializeExportBundle(payload);
    const winsCsv = bundle.files.find((file) => file.fileName === CSV_FILE_NAMES.wins);
    expect(winsCsv?.content).toContain('"第一行\n第二行"');
    expect(winsCsv?.content).toContain('2026-09-06,');
  });

  it('JSON 结构字段名与 PRD §9.1 一致', () => {
    const payload = createEmptyExportPayload('2026-09-12T00:00:00.000Z');
    const bundle = serializeExportBundle(payload);
    const jsonFile = bundle.files.find((file) => file.fileName === 'data.json');
    expect(jsonFile).toBeDefined();
    const parsed = JSON.parse(jsonFile?.content ?? '{}') as Record<string, unknown>;
    expect(parsed.meta).toEqual({
      app: 'qingshenghuo',
      // R11.4（四期）：`wins` 独立顶层键随 schemaVersion 2 引入（K25 只增不减）
      schemaVersion: 2,
      exportedAt: '2026-09-12T00:00:00.000Z',
    });
    expect(Object.keys(parsed)).toEqual(
      expect.arrayContaining(['meta', 'profile', 'goals', 'weights', 'meals', 'exercises', 'habits', 'water', 'wins', 'settings']),
    );
  });
});

describe('parseWeightCsv（导入）', () => {
  it('解析合法行（含 BOM、中文备注、带引号逗号）', () => {
    const text = `${CSV_BOM}date,weightKg,note\r\n2026-09-01,60,很好\r\n2026-09-02,59.8,"聚餐, 晚睡"`;
    const { rows, errors } = parseWeightCsv(text);
    expect(errors).toHaveLength(0);
    expect(rows).toEqual([
      { date: '2026-09-01', weightKg: 60, note: '很好' },
      { date: '2026-09-02', weightKg: 59.8, note: '聚餐, 晚睡' },
    ]);
  });

  it('非法行跳过并汇总（日期格式 / 体重越界）', () => {
    const text = ['date,weightKg,note', '2026/09/01,60,x', '2026-09-02,abc,y', '2026-09-03,500,z', '2026-09-04,59.5,ok'].join('\n');
    const { rows, errors } = parseWeightCsv(text);
    expect(rows).toEqual([{ date: '2026-09-04', weightKg: 59.5, note: 'ok' }]);
    expect(errors).toHaveLength(3);
    expect(errors.map((error) => error.row)).toEqual([2, 3, 4]);
  });

  it('缺少必需列 → 返回表头错误', () => {
    const { rows, errors } = parseWeightCsv('foo,bar\n1,2');
    expect(rows).toHaveLength(0);
    expect(errors[0]?.reason).toContain('表头');
  });

  it('空文件 → 报错而非崩溃', () => {
    const { rows, errors } = parseWeightCsv('');
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });
});
