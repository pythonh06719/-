import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CalorieCalculator from '@/components/common/CalorieCalculator';

/**
 * 免注册热量计算器（US-01）—— 纯组件、无网络。
 *
 * 默认表单值即 TC-01 输入（女 30 / 165cm / 60kg / 目标 55kg / 12 周 / 久坐）：
 * 期望 BMR = 1320、TDEE = 1584、建议摄入 = 1200（触安全下限）。
 */
describe('CalorieCalculator（免注册试用计算器）', () => {
  it('输入默认值并提交后，展示 BMR / TDEE / 建议摄入', () => {
    render(<CalorieCalculator />);

    fireEvent.click(screen.getByRole('button', { name: '计算我的每日预算' }));

    // BMR / TDEE / 建议摄入
    expect(screen.getByText('1320')).toBeInTheDocument();
    expect(screen.getByText('1584')).toBeInTheDocument();
    expect(screen.getByText('1200')).toBeInTheDocument();

    // 指标标签存在，说明三项都渲染了
    expect(screen.getByText('基础代谢 BMR')).toBeInTheDocument();
    expect(screen.getByText('每日消耗 TDEE')).toBeInTheDocument();
    expect(screen.getByText('建议摄入')).toBeInTheDocument();
  });

  it('触发安全下限时给出鼓励式提示（不含指责性措辞）', () => {
    render(<CalorieCalculator />);
    fireEvent.click(screen.getByRole('button', { name: '计算我的每日预算' }));

    expect(screen.getByText('这已接近安全下限，建议把目标调得更温和一些')).toBeInTheDocument();
  });
});
