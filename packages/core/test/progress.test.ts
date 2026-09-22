/**
 * 目标达成进度测试（`weight/progress.ts`，R2.7）。
 *
 * 钉死契约：
 * - 达成比 = (基准 − 最新) ÷ (基准 − 目标)，**钳制到 0~1**（增重不为负、超额不超 100%）；
 * - 已达成 → 维持模式：`etaWeeks` 强制为 `null`（**绝不出现「还需 0 周」**），`maintenanceKcal` 取 TDEE；
 * - 无记录 / 非减重目标 / 非法数值等边界不产生 NaN，且该返回 `null` 时返回 `null`。
 */

import { describe, expect, it } from 'vitest';

import { buildGoalProgress } from '../src/index';

describe('buildGoalProgress（R2.7 目标达成进度）', () => {
  it('未达成：达成比按 (基准 − 最新) ÷ (基准 − 目标)，并给出 ETA', () => {
    const progress = buildGoalProgress({
      baselineKg: 60,
      targetWeightKg: 52,
      latestKg: 56,
      etaWeeks: 8.4,
      maintenanceKcal: 1900,
    });

    expect(progress).not.toBeNull();
    // 掉了 4kg / 要掉 8kg = 50%
    expect(progress?.progressRatio).toBe(0.5);
    expect(progress?.reached).toBe(false);
    expect(progress?.maintenance).toBe(false);
    expect(progress?.remainingKg).toBe(4);
    expect(progress?.etaWeeks).toBe(8.4);
    // 非维持模式不下发维持热量
    expect(progress?.maintenanceKcal).toBeNull();
  });

  it('已达成 → 维持模式：etaWeeks 清空、maintenanceKcal 取 TDEE（取整）', () => {
    const progress = buildGoalProgress({
      baselineKg: 60,
      targetWeightKg: 52,
      latestKg: 51.6,
      // 引擎此时本就会给 null；即便调用方误传也必须在维持模式下清掉
      etaWeeks: 0,
      maintenanceKcal: 1932.6,
    });

    expect(progress?.reached).toBe(true);
    expect(progress?.maintenance).toBe(true);
    expect(progress?.progressRatio).toBe(1);
    expect(progress?.remainingKg).toBe(0);
    expect(progress?.etaWeeks).toBeNull();
    expect(progress?.maintenanceKcal).toBe(1933);
  });

  it('增重场景：达成比钳制到 0，remainingKg 为最新的超出量', () => {
    const progress = buildGoalProgress({
      baselineKg: 60,
      targetWeightKg: 52,
      latestKg: 62,
      etaWeeks: null,
      maintenanceKcal: null,
    });

    expect(progress?.progressRatio).toBe(0);
    expect(progress?.reached).toBe(false);
    expect(progress?.maintenance).toBe(false);
    expect(progress?.remainingKg).toBe(10);
    expect(progress?.etaWeeks).toBeNull();
  });

  it('还没有任何记录：latestKg 为 null → 进度 0、remaining/ETA 不给假数字', () => {
    const progress = buildGoalProgress({
      baselineKg: 60,
      targetWeightKg: 52,
      latestKg: null,
      etaWeeks: 8,
      maintenanceKcal: 1900,
    });

    expect(progress?.latestKg).toBeNull();
    expect(progress?.progressRatio).toBe(0);
    expect(progress?.remainingKg).toBeNull();
    expect(progress?.reached).toBe(false);
    expect(progress?.etaWeeks).toBe(8);
  });

  it('非减重目标（基准 ≤ 目标）：没高于目标即视为已走到终点', () => {
    const onTarget = buildGoalProgress({
      baselineKg: 52,
      targetWeightKg: 55,
      latestKg: 52,
      etaWeeks: null,
      maintenanceKcal: 1800,
    });
    expect(onTarget?.reached).toBe(true);
    expect(onTarget?.maintenance).toBe(true);
    expect(onTarget?.progressRatio).toBe(1);

    const above = buildGoalProgress({
      baselineKg: 52,
      targetWeightKg: 55,
      latestKg: 58,
      etaWeeks: null,
      maintenanceKcal: 1800,
    });
    expect(above?.reached).toBe(false);
    expect(above?.progressRatio).toBe(0);
    expect(above?.remainingKg).toBe(3);
  });

  it('边界：非法数值 / 非正数 / 脏 ETA → 返回 null 或清空 ETA（绝不产生 NaN）', () => {
    const base = { baselineKg: 60, targetWeightKg: 52, latestKg: 56, etaWeeks: null, maintenanceKcal: null };

    expect(buildGoalProgress({ ...base, baselineKg: Number.NaN })).toBeNull();
    expect(buildGoalProgress({ ...base, targetWeightKg: Number.POSITIVE_INFINITY })).toBeNull();
    expect(buildGoalProgress({ ...base, baselineKg: 0 })).toBeNull();
    expect(buildGoalProgress({ ...base, targetWeightKg: -1 })).toBeNull();

    // 脏数据：NaN / 0 / 负数 的 ETA 一律视为「没有 ETA」，不变成 NaN 周
    const dirty = buildGoalProgress({ ...base, etaWeeks: Number.NaN });
    expect(dirty?.etaWeeks).toBeNull();
    const zero = buildGoalProgress({ ...base, etaWeeks: 0 });
    expect(zero?.etaWeeks).toBeNull();
    const negative = buildGoalProgress({ ...base, etaWeeks: -3 });
    expect(negative?.etaWeeks).toBeNull();

    // latestKg 为 NaN 时按「无记录」处理，而不是算出 NaN 进度
    const dirtyLatest = buildGoalProgress({ ...base, latestKg: Number.NaN });
    expect(dirtyLatest?.latestKg).toBeNull();
    expect(dirtyLatest?.progressRatio).toBe(0);
  });
});
