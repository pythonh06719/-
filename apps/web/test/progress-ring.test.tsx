import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProgressRing from '@/components/common/ProgressRing';
import BigNumber from '@/components/common/BigNumber';

/** 进度环 / 大数字渲染（看板核心可视化）。 */
describe('ProgressRing', () => {
  it('以无障碍标签暴露进度百分比', () => {
    render(<ProgressRing value={0.5} centerValue="50%" centerLabel="今日进度" />);
    const ring = screen.getByRole('img');
    expect(ring).toHaveAttribute('aria-label', expect.stringContaining('50%'));
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('今日进度')).toBeInTheDocument();
  });

  it('进度超过 100% 时仍能正常渲染（使用柔和暖色而非红色恐吓）', () => {
    render(<ProgressRing value={1.4} centerValue="140%" centerLabel="今日进度" />);
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.getByText('140%')).toBeInTheDocument();
  });
});

describe('BigNumber', () => {
  it('渲染大数字、单位与说明文案', () => {
    render(
      <BigNumber caption="今日还能吃" value={1200} unit="kcal" hint="已摄入 300 kcal / 预算 1500 kcal" />,
    );
    expect(screen.getByText('今日还能吃')).toBeInTheDocument();
    expect(screen.getByText('1200')).toBeInTheDocument();
    expect(screen.getByText('kcal')).toBeInTheDocument();
    expect(screen.getByText('已摄入 300 kcal / 预算 1500 kcal')).toBeInTheDocument();
  });
});
