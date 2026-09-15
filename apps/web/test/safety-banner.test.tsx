import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ValidationWarning } from '@qsh/shared-types';
import SafetyBanner, { mergeSafetyNotices } from '@/components/feedback/SafetyBanner';

/**
 * 安全提示按 `code` 去重（ARCHITECTURE §4.5 末尾约定）。
 *
 * 同一条件（触安全下限）同时出现在 `safetyMessages` 与 `warnings` 时，
 * UI 只应展示一次。
 */

const FLOOR_MESSAGE = '这已接近安全下限，建议把目标调得更温和一些';

const WARNINGS: ValidationWarning[] = [
  { code: 'W_WEEKLY_LOSS_AGGRESSIVE', field: 'weeklyLossKg', message: '每周减重建议更温和一些（不超过当前体重的 2%）' },
  { code: 'W_FLOOR_APPLIED', message: FLOOR_MESSAGE },
];

describe('mergeSafetyNotices（去重）', () => {
  it('floorApplied=true 时按 code 去重，安全下限文案只出现一次', () => {
    const merged = mergeSafetyNotices([FLOOR_MESSAGE], WARNINGS, { floorApplied: true });
    expect(merged).toHaveLength(2);
    expect(merged.filter((item) => item === FLOOR_MESSAGE)).toHaveLength(1);
  });

  it('floorApplied=false 时两个通道各自展示（不误去重）', () => {
    const merged = mergeSafetyNotices([], WARNINGS, { floorApplied: false });
    expect(merged).toHaveLength(2);
  });

  it('空输入 → 空结果', () => {
    expect(mergeSafetyNotices([], [], {})).toEqual([]);
  });
});

describe('SafetyBanner', () => {
  it('渲染 safetyMessages 与未覆盖的告警', () => {
    render(
      <SafetyBanner
        safetyMessages={[FLOOR_MESSAGE]}
        warnings={WARNINGS}
        floorApplied
        isDeficitCapped
      />,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('每周减重建议更温和一些（不超过当前体重的 2%）')).toBeInTheDocument();
    expect(screen.getAllByText(FLOOR_MESSAGE)).toHaveLength(1);
  });

  it('无内容时不渲染（返回 null）', () => {
    const { container } = render(<SafetyBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});
