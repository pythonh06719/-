/**
 * 每日饮水目标纯口径单测（core/water/goal.ts，GAP-3）。
 *
 * 钉死两件事：
 * - 合法区间 500–8000（与后端两条通道一致）；
 * - 宽容归一化：越界 / 非整数 / 非数字一律回退默认 2000，绝不抛错。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WATER_GOAL_ML,
  WATER_GOAL_MAX_ML,
  WATER_GOAL_MIN_ML,
  isValidWaterGoalMl,
  normalizeWaterGoalMl,
} from '../src/index';

describe('isValidWaterGoalMl（区间 500–8000 的整数）', () => {
  it('常量与后端两条通道一致', () => {
    expect(WATER_GOAL_MIN_ML).toBe(500);
    expect(WATER_GOAL_MAX_ML).toBe(8000);
    expect(DEFAULT_WATER_GOAL_ML).toBe(2000);
  });

  it('边界值合法（含端点）', () => {
    expect(isValidWaterGoalMl(500)).toBe(true);
    expect(isValidWaterGoalMl(8000)).toBe(true);
    expect(isValidWaterGoalMl(2000)).toBe(true);
  });

  it('越界拒绝', () => {
    expect(isValidWaterGoalMl(499)).toBe(false);
    expect(isValidWaterGoalMl(8001)).toBe(false);
    expect(isValidWaterGoalMl(0)).toBe(false);
    expect(isValidWaterGoalMl(-500)).toBe(false);
  });

  it('非整数 / 非数字拒绝', () => {
    expect(isValidWaterGoalMl(2000.5)).toBe(false);
    expect(isValidWaterGoalMl('2000')).toBe(false);
    expect(isValidWaterGoalMl(Number.NaN)).toBe(false);
    expect(isValidWaterGoalMl(null)).toBe(false);
    expect(isValidWaterGoalMl(undefined)).toBe(false);
    expect(isValidWaterGoalMl({})).toBe(false);
  });
});

describe('normalizeWaterGoalMl（宽容归一化 → 默认 2000）', () => {
  it('合法值原样返回', () => {
    expect(normalizeWaterGoalMl(3200)).toBe(3200);
    expect(normalizeWaterGoalMl(500)).toBe(500);
    expect(normalizeWaterGoalMl(8000)).toBe(8000);
  });

  it('缺失 / 越界 / 非整数 / 非数字 → 回退默认 2000（旧备份兼容）', () => {
    expect(normalizeWaterGoalMl(undefined)).toBe(DEFAULT_WATER_GOAL_ML);
    expect(normalizeWaterGoalMl(null)).toBe(DEFAULT_WATER_GOAL_ML);
    expect(normalizeWaterGoalMl(499)).toBe(DEFAULT_WATER_GOAL_ML);
    expect(normalizeWaterGoalMl(8001)).toBe(DEFAULT_WATER_GOAL_ML);
    expect(normalizeWaterGoalMl(2000.5)).toBe(DEFAULT_WATER_GOAL_ML);
    expect(normalizeWaterGoalMl('2500')).toBe(DEFAULT_WATER_GOAL_ML);
  });
});
