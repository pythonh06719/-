/**
 * 体重趋势图测试（pages/weight/WeightChart.tsx）。
 *
 * 该组件由 ECharts 改为**手写 SVG**（去掉 `echarts` / `echarts-for-react` 依赖），
 * 因此这里钉死替换后必须保住的行为：
 * - 两条折线 + 全部记录点被渲染；
 * - 图例与横轴日期标签可见；
 * - 均线里的 `null` 是**断点**（拆成独立子路径，不跨断点连直线）；
 * - 单点 / 空数据等边界不崩，且单点时 y 轴收紧到 ±3。
 *
 * jsdom 无 `ResizeObserver`，组件会退回兜底画布尺寸 —— 恰好也覆盖了该分支。
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import WeightChart from '@/pages/weight/WeightChart';

const DATES = ['2026-09-01', '2026-09-02', '2026-09-03'];
const WEIGHTS = [60, 59.5, 59.8];

describe('WeightChart（手写 SVG 趋势图）', () => {
  it('渲染两条折线与全部记录点，并以无障碍标签暴露数据点数', () => {
    const { container } = render(
      <WeightChart dates={DATES} weights={WEIGHTS} movingAverage={[60, null, 59.65]} />,
    );

    expect(screen.getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('3 个数据点'));

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // 体重折线 + 7 日均线
    expect(svg?.querySelectorAll('path')).toHaveLength(2);
    // 每个记录点一个圆圈
    expect(svg?.querySelectorAll('circle')).toHaveLength(3);
  });

  it('图例与横轴日期标签可见', () => {
    render(<WeightChart dates={DATES} weights={WEIGHTS} movingAverage={[]} />);

    expect(screen.getByText('体重')).toBeInTheDocument();
    expect(screen.getByText('7 日均线')).toBeInTheDocument();
    expect(screen.getByText('9/1')).toBeInTheDocument();
    expect(screen.getByText('9/3')).toBeInTheDocument();
  });

  it('均线的 null 是断点：不跨断点连线（拆成两段子路径）', () => {
    const { container } = render(
      <WeightChart dates={DATES} weights={WEIGHTS} movingAverage={[60, null, 59.65]} />,
    );

    const paths = Array.from(container.querySelectorAll('path'));
    // 渲染顺序：7 日均线在前（更粗的线垫在下面），体重曲线在后
    const averagePath = paths[0];
    const moveCount = (averagePath?.getAttribute('d') ?? '').match(/M /g)?.length ?? 0;
    expect(moveCount).toBe(2);
  });

  it('单点：y 轴收紧到 ±3，点不会被压在默认宽区间中间', () => {
    const { container } = render(
      <WeightChart dates={['2026-09-01']} weights={[60]} movingAverage={[]} />,
    );

    // 只取 y 轴刻度（纯数字文本；横轴是 `9/1` 这类日期，Number 后为 NaN 被过滤）
    const ticks = Array.from(container.querySelectorAll('text'))
      .map((node) => Number(node.textContent))
      .filter((value) => Number.isFinite(value));

    expect(ticks.length).toBeGreaterThan(0);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(57);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(63);
  });

  it('空数据不崩，标签提示暂无数据', () => {
    render(<WeightChart dates={[]} weights={[]} movingAverage={[]} />);

    expect(screen.getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('暂无数据'));
  });

  it('未传 forecast：不画预测线、图例无「目标预测」（回归现有行为）', () => {
    const { container } = render(
      <WeightChart dates={DATES} weights={WEIGHTS} movingAverage={[60, null, 59.65]} />,
    );

    expect(container.querySelectorAll('path')).toHaveLength(2);
    expect(container.querySelectorAll('path[stroke-dasharray]')).toHaveLength(0);
    expect(screen.queryByText('目标预测')).toBeNull();
  });

  it('传入 forecast：多一条虚线 + 图例出现「目标预测」，且预测线不画数据点', () => {
    const { container } = render(
      <WeightChart
        dates={DATES}
        weights={WEIGHTS}
        movingAverage={[60, null, 59.65]}
        forecast={[
          { date: '2026-09-01', weightKg: 60 },
          { date: '2026-09-08', weightKg: 58 },
          { date: '2026-09-15', weightKg: 56 },
        ]}
      />,
    );

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // 预测线 + 7 日均线 + 体重曲线
    expect(svg?.querySelectorAll('path')).toHaveLength(3);
    // 恰好一条虚线（预测线）
    expect(svg?.querySelectorAll('path[stroke-dasharray]')).toHaveLength(1);
    // 预测线不画数据点：圆圈仍只有实际体重记录的 3 个
    expect(svg?.querySelectorAll('circle')).toHaveLength(3);

    expect(screen.getByText('目标预测')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('目标达成预测线'),
    );
  });
});
