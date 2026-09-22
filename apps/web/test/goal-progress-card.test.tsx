/**
 * 目标达成进度卡测试（pages/weight/GoalProgressCard.tsx，R2.7）。
 *
 * 钉死两条最容易回归的语义：
 * - 未达成：进度环百分比 + 「距离目标还有 X kg」+「按当前节奏还需 X 周」（周数向上取整）；
 * - **维持模式**：显示「已经到啦 + 维持热量」，且**绝不出现「还需 X 周」/「继续减」**
 *   —— 已达成目标时再暗示制造缺口是错误引导（PRD §7）。
 * - ETA 算不出来时退回「目标 X kg」，不编造周数。
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GoalProgress } from '@qsh/shared-types';
import GoalProgressCard from '@/pages/weight/GoalProgressCard';

/** 未达成（掉了 4kg / 要掉 8kg = 50%，ETA 8.4 周 → 展示 9 周）。 */
const IN_PROGRESS: GoalProgress = {
  baselineKg: 60,
  targetWeightKg: 52,
  latestKg: 56,
  progressRatio: 0.5,
  reached: false,
  remainingKg: 4,
  etaWeeks: 8.4,
  maintenance: false,
  maintenanceKcal: null,
};

/** 已达成 → 维持模式。 */
const MAINTAINING: GoalProgress = {
  baselineKg: 60,
  targetWeightKg: 52,
  latestKg: 51.6,
  progressRatio: 1,
  reached: true,
  remainingKg: 0,
  etaWeeks: null,
  maintenance: true,
  maintenanceKcal: 1932.6,
};

describe('GoalProgressCard（R2.7 目标达成进度卡）', () => {
  it('未达成：显示 50% 进度、「还差多少」与向上取整的周数', () => {
    render(<GoalProgressCard progress={IN_PROGRESS} />);

    expect(screen.getByRole('region', { name: '距离目标' })).toBeDefined();
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '目标进度 50%');
    expect(screen.getByText('50%')).toBeDefined();
    expect(screen.getByText('距离目标还有 4.0 kg')).toBeDefined();
    // 8.4 周 → 9 周（不说「0 周」，也不报小数）
    expect(screen.getByText('按当前节奏还需 9 周')).toBeDefined();
    // 可解释性：说明百分比的分母来自哪里
    expect(screen.getByText('从 60.0 kg 出发，目标 52.0 kg')).toBeDefined();
  });

  it('维持模式：显示「已经到啦」与维持热量，绝不出现「还需 X 周」', () => {
    render(<GoalProgressCard progress={MAINTAINING} />);

    expect(screen.getByRole('region', { name: '已经到啦' })).toBeDefined();
    expect(screen.getByText('已经到啦，接下来把节奏稳住就好')).toBeDefined();
    expect(screen.getByText('维持热量约 1933 kcal/日，不用再往下压')).toBeDefined();

    // 硬约束：已达成目标时不得再出现「还需」周数，也不得出现「继续减」类暗示
    expect(screen.queryByText(/还需/)).toBeNull();
    expect(screen.queryByText(/继续减/)).toBeNull();
  });

  it('ETA 算不出来：退回「目标 X kg」，不编造周数', () => {
    render(<GoalProgressCard progress={{ ...IN_PROGRESS, etaWeeks: null }} />);

    expect(screen.getByText('目标 52.0 kg，按自己的节奏来')).toBeDefined();
    expect(screen.queryByText(/还需/)).toBeNull();
  });

  it('还没有任何记录：remainingKg 为 null 时退回目标值，进度环显示 0%', () => {
    render(<GoalProgressCard progress={{ ...IN_PROGRESS, latestKg: null, remainingKg: null, progressRatio: 0 }} />);

    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '目标进度 0%');
    expect(screen.queryByText(/距离目标还有/)).toBeNull();
    expect(screen.getByText('按当前节奏还需 9 周')).toBeDefined();
  });
});
