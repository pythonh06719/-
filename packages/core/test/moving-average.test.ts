import { describe, expect, it } from 'vitest';

import {
  computeMovingAverage7d,
  MOVING_AVERAGE_SHARED_CASES,
  MOVING_AVERAGE_WINDOW_DAYS,
  type MovingAverageInputPoint,
} from '../src/weight/moving-average';

/**
 * 7 日移动平均真源单测（NFR-11 唯一口径）。
 *
 * 除自身边界外，这里跑的 `MOVING_AVERAGE_SHARED_CASES` 与 `apps/api`、`apps/web` 的
 * 跨端用例**是同一份数据**，因此「服务端与前端一致」是被断言钉住的，不是注释承诺。
 */

describe('computeMovingAverage7d（真源）', () => {
  it('窗口常量 = 7（契约字段名 movingAverage7 由此得名）', () => {
    expect(MOVING_AVERAGE_WINDOW_DAYS).toBe(7);
  });

  it('共享用例集非空（防误删导致三处测试空跑）', () => {
    expect(MOVING_AVERAGE_SHARED_CASES.length).toBeGreaterThan(10);
  });

  for (const testCase of MOVING_AVERAGE_SHARED_CASES) {
    it(`共享用例 · ${testCase.name}`, () => {
      expect(computeMovingAverage7d(testCase.points)).toEqual(testCase.expected);
    });
  }

  it('纯函数：不修改入参顺序', () => {
    const input: MovingAverageInputPoint[] = [
      { date: '2026-09-05', weightKg: 64 },
      { date: '2026-09-01', weightKg: 60 },
    ];
    const snapshot = [...input];
    computeMovingAverage7d(input);
    expect(input).toEqual(snapshot);
  });

  it('窗口是「含当日的日历 7 天」，不是「最近 7 条记录」', () => {
    // 前 3 天连续，然后跳到 09-10：09-10 的日历窗口是 09-04..09-10，只含 09-10 自身
    const result = computeMovingAverage7d([
      { date: '2026-09-01', weightKg: 60 },
      { date: '2026-09-02', weightKg: 62 },
      { date: '2026-09-03', weightKg: 64 },
      { date: '2026-09-10', weightKg: 66 },
    ]);
    // 日历口径 → 66；若误按「最近 7 条记录」会把 4 条全算进去 → (60+62+64+66)/4 = 63
    expect(result[3]?.value).toBe(66);
    expect(result[0]?.value).toBe(60);
  });

  it('缺天时分母 = 窗口内已有条数（不是 7）', () => {
    // 窗口 09-01..09-07 内只有 2 条：若误用 7 作分母会得到 (60+62)/7 = 17.43
    const result = computeMovingAverage7d([
      { date: '2026-09-01', weightKg: 60 },
      { date: '2026-09-07', weightKg: 62 },
    ]);
    expect(result[1]?.value).toBe(61);
  });

  it('记录不足 7 天（前 6 天）照算，首日 = 首日体重', () => {
    const result = computeMovingAverage7d([
      { date: '2026-09-01', weightKg: 70.5 },
      { date: '2026-09-02', weightKg: 70.1 },
    ]);
    expect(result[0]?.value).toBe(70.5);
    expect(result[1]?.value).toBe(70.3);
  });
});
