import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProgressRing from '@/components/common/ProgressRing';

/** 进度环渲染（看板核心可视化）。 */
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
