import { describe, expect, it } from 'vitest';
import type { WeightTrendPoint } from '@qsh/shared-types';
import { computeMovingAverage7d, computeTrendStats, isWeightRising } from '@/lib/trend';

/**
 * 7 日移动平均纯函数单测（T04 DoD 第 3 项）。
 *
 * 覆盖边界：空数据、单点、**不足 7 天**、恰好 7 天、超过 7 天滑动窗口、**有空缺日**。
 */

function point(date: string, weightKg: number): WeightTrendPoint {
  return { date, weightKg };
}

describe('computeMovingAverage7d', () => {
  it('空数组 → 空结果', () => {
    expect(computeMovingAverage7d([])).toEqual([]);
  });

  it('单点 → 平均值即自身', () => {
    const result = computeMovingAverage7d([point('2026-09-01', 60)]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ date: '2026-09-01', value: 60 });
  });

  it('不足 7 天 → 用窗口内已有点求平均（不补零）', () => {
    const result = computeMovingAverage7d([
      point('2026-09-01', 60),
      point('2026-09-02', 62),
      point('2026-09-03', 64),
    ]);
    expect(result.map((item) => item.value)).toEqual([60, 61, 62]);
  });

  it('恰好 7 天 → 最后一天为全部 7 点平均', () => {
    const dates = ['01', '02', '03', '04', '05', '06', '07'];
    const points = dates.map((day, index) => point(`2026-09-${day}`, 50 + index)); // 50..56
    const result = computeMovingAverage7d(points);
    // 平均 = (50+51+52+53+54+55+56)/7 = 53
    expect(result[6]?.value).toBe(53);
  });

  it('超过 7 天 → 滑动窗口只覆盖最近 7 个自然日', () => {
    const days = ['01', '02', '03', '04', '05', '06', '07', '08'];
    const points = days.map((day, index) => point(`2026-09-${day}`, 60 + index)); // 60..67
    const result = computeMovingAverage7d(points);
    // 第 7 天（09-07）：窗口 09-01..09-07 → 平均 (60..66) = 63
    expect(result[6]?.value).toBe(63);
    // 第 8 天（09-08）：窗口 09-02..09-08 → 平均 (61..67) = 64
    expect(result[7]?.value).toBe(64);
  });

  it('有空缺日 → 窗口按自然日计算，缺口不参与平均', () => {
    const result = computeMovingAverage7d([point('2026-09-01', 70), point('2026-09-10', 68)]);
    // 09-10 的窗口是 09-04..09-10，只含 09-10 自身
    expect(result[1]).toEqual({ date: '2026-09-10', value: 68 });
    expect(result[0]).toEqual({ date: '2026-09-01', value: 70 });
  });

  it('输入乱序 → 输出按日期升序', () => {
    const result = computeMovingAverage7d([point('2026-09-03', 64), point('2026-09-01', 60)]);
    expect(result.map((item) => item.date)).toEqual(['2026-09-01', '2026-09-03']);
  });
});

describe('computeTrendStats / isWeightRising', () => {
  it('统计最小 / 最大 / 最新 / 净变化', () => {
    const stats = computeTrendStats([
      point('2026-09-01', 60),
      point('2026-09-02', 58.4),
      point('2026-09-03', 59.2),
    ]);
    expect(stats.minKg).toBe(58.4);
    expect(stats.maxKg).toBe(60);
    expect(stats.latestKg).toBe(59.2);
    expect(stats.changeKg).toBe(-0.8);
  });

  it('空数据统计为 null', () => {
    expect(computeTrendStats([])).toEqual({ minKg: null, maxKg: null, latestKg: null, changeKg: null });
  });

  it('最新一点高于前一点 → 判定为上涨（触发中性文案）', () => {
    expect(isWeightRising([point('2026-09-01', 60), point('2026-09-02', 60.8)])).toBe(true);
    expect(isWeightRising([point('2026-09-01', 60), point('2026-09-02', 59.2)])).toBe(false);
    expect(isWeightRising([point('2026-09-01', 60)])).toBe(false);
  });
});
