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
 * R2.6 目标预测曲线追加断言（坐标轴以实际数据为基准，预测线不得支配坐标轴）：
 * - x 轴右端外扩有上限（预测很远也不会把实际点压到左侧）；
 * - x 轴标签按像素间距 ≥ 44px 去重、首尾优先；
 * - 预测线超出 x / y 域的部分被裁剪；
 * - 无 forecast 时铺满全宽、无虚线、无图例项（与改动前一致）。
 *
 * jsdom 无 `ResizeObserver`，组件会退回兜底画布尺寸 —— 恰好也覆盖了该分支。
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import WeightChart from '@/pages/weight/WeightChart';

const DATES = ['2026-09-01', '2026-09-02', '2026-09-03'];
const WEIGHTS = [60, 59.5, 59.8];

/** 兜底画布尺寸与内边距（与组件内常量一致）。 */
const PLOT_LEFT = 40;
const PLOT_WIDTH = 600 - 40 - 16; // 544
const PLOT_RIGHT = PLOT_LEFT + PLOT_WIDTH; // 584

/** `YYYY-MM-DD` 加天数（本地日粒度）。 */
function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() + days);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** 从 `2026-09-01` 起的连续 N 天日期。 */
function dailyDates(count: number): string[] {
  return Array.from({ length: count }, (_, index) => addDays('2026-09-01', index));
}

/** 取 svg 中「日期标签」（形如 `9/1`）的 x 像素坐标，升序。 */
function labelXs(svg: SVGSVGElement): number[] {
  return Array.from(svg.querySelectorAll('text'))
    .filter((node) => /^\d+\/\d+$/.test((node.textContent ?? '').trim()))
    .map((node) => Number(node.getAttribute('x')))
    .sort((a, b) => a - b);
}

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

  it('未传 forecast：不画预测线、无图例项，且实际数据铺满全宽（回归现有行为）', () => {
    const { container } = render(
      <WeightChart dates={DATES} weights={WEIGHTS} movingAverage={[60, null, 59.65]} />,
    );

    expect(container.querySelectorAll('path')).toHaveLength(2);
    expect(container.querySelectorAll('path[stroke-dasharray]')).toHaveLength(0);
    expect(screen.queryByText(/目标预测/)).toBeNull();

    // 无预测 → x 域 = 实际数据范围 → 最后一个点贴到绘图区右边缘（铺满全宽）
    const circles = Array.from(container.querySelectorAll('circle'));
    const lastCx = Number(circles[circles.length - 1]?.getAttribute('cx'));
    expect(lastCx).toBeGreaterThanOrEqual(PLOT_RIGHT - 4);
  });

  it('传入 forecast：多一条虚线 + 图例（含目标值），且预测线不画数据点', () => {
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

    // 图例显示目标值（预测末端 = 56.0）
    expect(screen.getByText(/目标预测/)).toBeInTheDocument();
    expect(screen.getByText(/目标 56\.0 kg/)).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('目标达成预测线'),
    );
  });

  it('x 域外扩有上限：预测延伸到很远时，实际点仍占据绘图区右侧大部分', () => {
    const dates = dailyDates(30); // 9/1 ~ 9/30（跨 29 天）
    const weights = dates.map((_, index) => 99 + (index % 3) * 0.3); // 99.0 ~ 99.6，小幅波动
    const forecast = Array.from({ length: 30 }, (_, index) => ({
      date: addDays('2026-09-01', index * 7), // 延伸到约 205 天后
      weightKg: 100 - index * 1.25,
    }));

    const { container } = render(
      <WeightChart
        dates={dates}
        weights={weights}
        movingAverage={dates.map(() => null)}
        forecast={forecast}
      />,
    );

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();

    // 最后一个实际点若被预测终点支配会落到约 x≈107（左 1/5）；外扩上限后应在右半区（> 312）
    const circles = Array.from(container.querySelectorAll('circle'));
    const lastCx = Number(circles[circles.length - 1]?.getAttribute('cx'));
    expect(lastCx).toBeGreaterThan(PLOT_LEFT + PLOT_WIDTH * 0.5);
    expect(lastCx).toBeLessThanOrEqual(PLOT_RIGHT);
  });

  it('x 轴标签按像素间距 ≥ 44px 去重，首尾标签保留', () => {
    const dates = dailyDates(30);
    const weights = dates.map((_, index) => 99 + (index % 3) * 0.3);
    const forecast = Array.from({ length: 30 }, (_, index) => ({
      date: addDays('2026-09-01', index * 7),
      weightKg: 100 - index * 1.25,
    }));

    const { container } = render(
      <WeightChart
        dates={dates}
        weights={weights}
        movingAverage={dates.map(() => null)}
        forecast={forecast}
      />,
    );

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();

    const xs = labelXs(svg as SVGSVGElement);
    expect(xs.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < xs.length; i += 1) {
      expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(44);
    }

    // 首尾标签优先保留
    expect(screen.getByText('9/1')).toBeInTheDocument();
    expect(screen.getByText('9/30')).toBeInTheDocument();
  });

  it('预测线裁剪：超出 x 域的点被丢弃，路径顶点数受限', () => {
    const forecast = Array.from({ length: 20 }, (_, index) => ({
      date: addDays('2026-09-01', index * 7), // 19 段，远超出 3 天窗口
      weightKg: 60 - index * 1.3,
    }));

    const { container } = render(
      <WeightChart
        dates={DATES}
        weights={WEIGHTS}
        movingAverage={[]}
        forecast={forecast}
      />,
    );

    const paths = Array.from(container.querySelectorAll('path'));
    // 预测线渲染在最前
    const d = paths[0]?.getAttribute('d') ?? '';
    const quadratics = (d.match(/Q /g) ?? []).length;
    // 窗口（9/1 ~ 9/17）内仅含 3 个预测点 → 2 段；未裁剪会是 19 段
    expect(quadratics).toBeGreaterThanOrEqual(1);
    expect(quadratics).toBeLessThanOrEqual(3);
  });
});
