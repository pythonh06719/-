import { describe, expect, it } from 'vitest';

import {
  DRINK_LIBRARY,
  MET_ACTIVITY_LIBRARY,
  TAKEOUT_LIBRARY,
  calcExerciseKcal,
  escapeCsvField,
  estimateDrink,
  estimateFeast,
  estimateTakeout,
  exerciseMinutesForKcal,
  findMetActivity,
  parseWeightCsv,
  serializeCsv,
  snackRedemption,
  withBom,
} from '../src/index';

/** 快走 / 散步 / 慢跑 的 MET（与 met.ts 内置表一致）。 */
const MET_WALK_BRISK = 5.0;
const MET_WALK_SLOW = 3.0;
const MET_JOG = 8.3;
const WEIGHT = 60;

const lookup = (code: string) => {
  const found = findMetActivity(code);
  return found ? { name: found.name, met: found.met } : undefined;
};

describe('运动 MET（R6.1 / R6.2）', () => {
  it('内置表：编码唯一、MET 均为正、含快走/慢跑等常见活动', () => {
    expect(MET_ACTIVITY_LIBRARY.length).toBeGreaterThanOrEqual(10);
    const codes = MET_ACTIVITY_LIBRARY.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const activity of MET_ACTIVITY_LIBRARY) {
      expect(activity.met).toBeGreaterThan(0);
      expect(activity.name.length).toBeGreaterThan(0);
    }
  });

  it('消耗 = MET × 体重 × 时长：快走 5.0 MET × 60kg × 30min = 150 kcal', () => {
    expect(calcExerciseKcal(MET_WALK_BRISK, WEIGHT, 30)).toBe(150);
  });

  it('保留 1 位小数：散步 3.0 × 60kg × 20min = 60', () => {
    expect(calcExerciseKcal(MET_WALK_SLOW, WEIGHT, 20)).toBe(60);
  });

  it('非法入参返回 0（不抛错）', () => {
    expect(calcExerciseKcal(0, WEIGHT, 30)).toBe(0);
    expect(calcExerciseKcal(-1, WEIGHT, 30)).toBe(0);
    expect(calcExerciseKcal(MET_WALK_BRISK, 0, 30)).toBe(0);
    expect(calcExerciseKcal(MET_WALK_BRISK, WEIGHT, 0)).toBe(0);
    expect(calcExerciseKcal(Number.NaN, WEIGHT, 30)).toBe(0);
  });

  it('「吃掉它需要多少运动」：232 kcal 快走(5.0) 60kg → 47 分钟（向上取整）', () => {
    // 232 / (5.0 × 60) × 60 = 46.4 → 47
    expect(exerciseMinutesForKcal(232, MET_WALK_BRISK, WEIGHT)).toBe(47);
  });

  it('换算在零热量 / 非法入参下返回 0', () => {
    expect(exerciseMinutesForKcal(0, MET_WALK_BRISK, WEIGHT)).toBe(0);
    expect(exerciseMinutesForKcal(232, 0, WEIGHT)).toBe(0);
    expect(exerciseMinutesForKcal(232, MET_WALK_BRISK, -1)).toBe(0);
  });

  it('findMetActivity 命中与未命中', () => {
    expect(findMetActivity('walking_brisk')?.name).toBe('快走');
    expect(findMetActivity('not_exist')).toBeUndefined();
  });
});

describe('生活化工具（R5.1~R5.4）', () => {
  it('外卖：麻辣烫区间合理、假设透明、替换建议充足；未知类型返回 undefined', () => {
    const malatang = estimateTakeout('malatang');
    expect(malatang).toBeDefined();
    expect(malatang!.range.min).toBeLessThan(malatang!.range.max);
    expect(malatang!.assumption.length).toBeGreaterThan(5);
    expect(malatang!.swaps.length).toBeGreaterThanOrEqual(2);
    expect(TAKEOUT_LIBRARY.length).toBeGreaterThanOrEqual(5);
    expect(estimateTakeout('not_exist')).toBeUndefined();
  });

  it('聚餐：人均区间 + 当天调整建议；未知类型返回 undefined', () => {
    const hotpot = estimateFeast('hotpot');
    expect(hotpot).toBeDefined();
    expect(hotpot!.perPerson.min).toBeGreaterThan(0);
    expect(hotpot!.adjustTips.length).toBeGreaterThanOrEqual(2);
    expect(estimateFeast('not_exist')).toBeUndefined();
  });

  it('饮品：奶茶 500ml 全糖 → 基准 325 kcal，区间 ±10%', () => {
    const full = estimateDrink('milk_tea', 500, 'full');
    // 65 × 500 / 100 × 1.15 = 373.75 → 区间 [336, 411]
    expect(full.range.max).toBeGreaterThan(full.range.min);
    expect(full.range.min).toBeGreaterThan(300);
    expect(full.sizeMl).toBe(500);
  });

  it('饮品：无糖显著低于正常糖；非法类型回退第一项；非法杯型回退默认', () => {
    const regular = estimateDrink('milk_tea', 500, 'regular');
    const none = estimateDrink('milk_tea', 500, 'none');
    expect(none.range.max).toBeLessThan(regular.range.min);
    expect(DRINK_LIBRARY.length).toBeGreaterThanOrEqual(5);
    // 未知类型 → 回退第一项（奶茶），未知杯型 → 默认 500ml
    const fallback = estimateDrink('not_exist', Number.NaN);
    expect(fallback.sizeMl).toBe(500);
  });

  it('零食救赎：232 kcal 60kg → 三种活动分钟数 + 替代建议', () => {
    const result = snackRedemption('薯片', 232, WEIGHT, lookup);
    expect(result.kcal).toBe(232);
    expect(result.exercise).toHaveLength(3);
    const brisk = result.exercise.find((item) => item.activityName === '快走');
    expect(brisk?.minutes).toBe(47);
    // 慢跑 MET 更高 → 分钟数更少
    const jog = result.exercise.find((item) => item.activityName === '慢跑');
    const slow = result.exercise.find((item) => item.activityName === '散步');
    expect(jog!.minutes).toBeLessThan(brisk!.minutes);
    expect(slow!.minutes).toBeGreaterThan(brisk!.minutes);
    expect(result.swaps.length).toBeGreaterThanOrEqual(2);
  });

  it('零食救赎：高热量零食给出不同的替代建议；零热量不崩', () => {
    expect(snackRedemption('炸鸡', 500, WEIGHT, lookup).swaps).not.toEqual(
      snackRedemption('海苔', 30, WEIGHT, lookup).swaps,
    );
    expect(snackRedemption('未知', 0, WEIGHT, lookup).exercise.every((item) => item.minutes === 0)).toBe(
      true,
    );
  });
});

describe('数据主权序列化（§9 / K11）', () => {
  it('escapeCsvField：普通值原样、逗号/引号/换行按 RFC 4180 转义、空值输出空串', () => {
    expect(escapeCsvField('米饭')).toBe('米饭');
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('说"你好"')).toBe('"说""你好"""');
    expect(escapeCsvField('多\n行')).toBe('"多\n行"');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
    expect(escapeCsvField(123)).toBe('123');
  });

  it('serializeCsv：首行表头、CRLF 行尾', () => {
    const csv = serializeCsv(['date', 'weightKg'], [
      { date: '2026-09-12', weightKg: 60.5 },
      { date: '2026-09-13', weightKg: '60,2' },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('date,weightKg');
    expect(lines[1]).toBe('2026-09-12,60.5');
    expect(lines[2]).toBe('2026-09-13,"60,2"');
  });

  it('withBom：以 UTF-8 BOM 开头', () => {
    expect(withBom('date').charCodeAt(0)).toBe(0xfeff);
  });

  it('escapeCsvField：公式注入前缀（= + - @ 制表）被单引号中和（审查 #2）', () => {
    // 带引号/逗号的注入载荷：先中和前缀、再整体引号包裹（解析出的值以 ' 开头 → Excel 当文本）
    expect(escapeCsvField('=HYPERLINK("http://evil","点这")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""点这"")"',
    );
    expect(escapeCsvField('+1')).toBe("'+1");
    expect(escapeCsvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvField('-5kg')).toBe("'-5kg");
    // 正常文本不受影响
    expect(escapeCsvField('晨起空腹')).toBe('晨起空腹');
    expect(escapeCsvField('中间有=号不处理')).toBe('中间有=号不处理');
  });

  it('parseWeightCsv：合法行解析、BOM 剥离、列顺序无关', () => {
    const text = '\uFEFFweightKg,date,note\r\n60.5,2026-09-12,晨起空腹\r\n59.8,2026-09-13,';
    const parsed = parseWeightCsv(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { date: '2026-09-12', weightKg: 60.5, note: '晨起空腹' },
      { date: '2026-09-13', weightKg: 59.8 },
    ]);
  });

  it('parseWeightCsv：引号包裹字段（含逗号与 "" 转义）正确解析，不被误拆列', () => {
    const text = 'date,weightKg,note\r\n2026-09-12,60.2,"备注含,逗号与""引号"""';
    const parsed = parseWeightCsv(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { date: '2026-09-12', weightKg: 60.2, note: '备注含,逗号与"引号"' },
    ]);
  });

  it('parseWeightCsv：非法行跳过并汇总，不影响合法行', () => {
    const text = 'date,weightKg\r\n2026-02-30,60\r\nabc,60\r\n2026-09-13,0\r\n2026-09-14,61.2\r\n';
    const parsed = parseWeightCsv(text);
    expect(parsed.rows).toEqual([{ date: '2026-09-14', weightKg: 61.2 }]);
    expect(parsed.errors).toHaveLength(3);
    expect(parsed.errors[0]!.row).toBe(2);
  });

  it('parseWeightCsv：缺表头列 / 空文件 / 超长备注截断', () => {
    expect(parseWeightCsv('date,note\r\n2026-09-12,x').errors[0]!.reason).toContain('weightKg');
    expect(parseWeightCsv('').errors[0]!.reason).toContain('空');
    const long = parseWeightCsv('date,weightKg,note\r\n2026-09-12,60,' + '长'.repeat(260));
    expect(long.rows[0]!.note!.length).toBe(200);
  });
});
