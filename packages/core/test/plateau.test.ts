/**
 * 平台期判定测试（`weight/plateau.ts`，R2.7）。
 *
 * 钉死契约：
 * - 观察窗 21 天 / 阈值 0.3kg / 至少 3 个记录日：数据不足时**不触发**；
 * - 停滞天数 = 「最近一次明显变化的那天」到最新记录日的跨度；
 * - 4 周斜率用最小二乘回归，单位 kg/周，数据不足时为 `null`（绝不返回 NaN）；
 * - 优先吃 7 日均线（噪声更小的那个），均线不足才退回原始点；
 * - 停更保护：最后一条记录距今过久时不判定为平台期。
 */

import { describe, expect, it } from 'vitest';

import {
  PLATEAU_THRESHOLD_KG,
  PLATEAU_WINDOW_DAYS,
  detectWeightPlateau,
} from '../src/index';
import type { PlateauPoint } from '../src/index';

/** `YYYY-MM-DD` 加天数（本地日粒度）。 */
function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() + days);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** 从 `start` 起的连续 `count` 天序列，体重由 `weightAt(index)` 决定。 */
function daily(
  start: string,
  count: number,
  weightAt: (index: number) => number,
): PlateauPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    date: addDays(start, index),
    weightKg: weightAt(index),
  }));
}

/** 把点序列包装成「7 日均线」输入形态（`value` 字段）。 */
function asAverage(points: ReadonlyArray<PlateauPoint>): Array<{ date: string; value: number | null }> {
  return points.map((point) => ({ date: point.date, value: point.weightKg }));
}

describe('detectWeightPlateau（R2.7 平台期判定）', () => {
  it('数据不足（只有 10 天）→ 不触发，且不谎报停滞天数', () => {
    const points = daily('2026-09-01', 10, () => 60);
    const result = detectWeightPlateau({ points });

    expect(result.isPlateau).toBe(false);
    expect(result.stalledDays).toBe(9);
    expect(result.stalledDays).toBeLessThan(PLATEAU_WINDOW_DAYS);
  });

  it('连续 30 天纹丝不动 → 触发平台期，停滞 29 天、4 周斜率 0', () => {
    const points = daily('2026-09-01', 30, () => 60);
    const result = detectWeightPlateau({ points });

    expect(result.isPlateau).toBe(true);
    expect(result.stalledDays).toBe(29);
    expect(result.slope4wKgPerWeek).toBe(0);
    expect(result.windowDays).toBe(PLATEAU_WINDOW_DAYS);
    expect(result.thresholdKg).toBe(PLATEAU_THRESHOLD_KG);
  });

  it('稳定下降（每周 -0.5kg）→ 不触发，但能算出 -0.5 kg/周', () => {
    const points = daily('2026-09-01', 45, (index) => 70 - index * (0.5 / 7));
    const result = detectWeightPlateau({ points });

    expect(result.isPlateau).toBe(false);
    // 0.3kg ÷ (0.5/7 kg每天) ≈ 4.2 天，远未到 21 天
    expect(result.stalledDays).toBeLessThan(PLATEAU_WINDOW_DAYS);
    expect(result.slope4wKgPerWeek).toBeCloseTo(-0.5, 2);
  });

  it('4 周斜率精度：28 天净降 2kg → 恰好 -0.5 kg/周', () => {
    // 29 个点跨 28 天：60 → 58 线性
    const points = daily('2026-09-01', 29, (index) => 60 - index / 14);
    const result = detectWeightPlateau({ points, asOf: '2026-09-29' });

    expect(result.slope4wKgPerWeek).toBe(-0.5);
  });

  it('边界：空数组 / 单点 / 两点 → 不触发且斜率为 null（不产生 NaN）', () => {
    expect(detectWeightPlateau({}).isPlateau).toBe(false);
    expect(detectWeightPlateau({ points: [] }).slope4wKgPerWeek).toBeNull();

    const single = detectWeightPlateau({ points: daily('2026-09-01', 1, () => 60) });
    expect(single.isPlateau).toBe(false);
    expect(single.slope4wKgPerWeek).toBeNull();

    // 只有 2 个点、却跨了 40 天：不能因为「没变化」就判成平台期（分不清没变 / 没记）
    const two = detectWeightPlateau({
      points: [
        { date: '2026-09-01', weightKg: 60 },
        { date: '2026-10-11', weightKg: 60 },
      ],
    });
    expect(two.isPlateau).toBe(false);
  });

  it('优先吃 7 日均线：原始点抖动大但均线平和 → 仍判定为平台期', () => {
    const raw = daily('2026-09-01', 30, (index) => (index % 2 === 0 ? 60 : 61));
    const smooth = daily('2026-09-01', 30, () => 60);

    const withMa = detectWeightPlateau({ points: raw, movingAverage: asAverage(smooth) });
    expect(withMa.isPlateau).toBe(true);
    expect(withMa.stalledDays).toBe(29);

    // 不传均线时退回原始点：抖动 1kg > 0.3kg 阈值，因此不判平台期（证明「均线优先」确实生效）
    const withoutMa = detectWeightPlateau({ points: raw });
    expect(withoutMa.isPlateau).toBe(false);
  });

  it('均线上的 null 断点是被跳过的，不参与判定', () => {
    const points = daily('2026-09-01', 30, () => 60);
    const movingAverage = asAverage(points).map((item, index) =>
      index % 3 === 0 ? { date: item.date, value: null } : item,
    );
    const result = detectWeightPlateau({ points, movingAverage });

    expect(result.isPlateau).toBe(true);
    // 首个有效点是 9/2（9/1 是断点了），到 9/30 共 28 天 —— 断点不参与，但跨度照实算
    expect(result.stalledDays).toBe(28);
  });

  it('停更保护：最后一条记录距今过久 → 不算平台期（那是没在记录，不是体重不动）', () => {
    const points = daily('2026-09-01', 30, () => 60);

    const fresh = detectWeightPlateau({ points, asOf: '2026-09-30' });
    expect(fresh.isPlateau).toBe(true);

    // 最后一条是 9/30，参照日已是 11/01（隔了 32 天）
    const stale = detectWeightPlateau({ points, asOf: '2026-11-01' });
    expect(stale.isPlateau).toBe(false);
    // 斜率照常给出：不判定 ≠ 不给数据
    expect(stale.slope4wKgPerWeek).toBe(0);
  });

  it('先降后平：只统计「最近这段平了多少天」，不把前面下降的日子算进去', () => {
    // 前 10 天从 62 降到 60，之后 25 天保持 60
    const points = daily('2026-09-01', 35, (index) => (index < 10 ? 62 - index * 0.2 : 60));
    const result = detectWeightPlateau({ points });

    expect(result.isPlateau).toBe(true);
    // 平稳段起点是第 10 天（索引 9，9/10）→ 到 10/05 共 25 天
    expect(result.stalledDays).toBe(25);
  });
});
