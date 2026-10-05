/**
 * Sparkline 的**等比缩放**护栏（components/common/Sparkline.tsx）。
 *
 * 修的真实缺陷：此前 `<svg width="100%" viewBox="0 0 260 72" preserveAspectRatio="none">`
 * —— scaleY 恒为 1（height 属性与 viewBox 高都是 72），而 scaleX = 容器实际宽 / 260。
 * 移动端卡片内宽约 328 → 1.26；宽屏（`AppShell` 的 `max-w-3xl`）可达 2.8。后果两条：
 *   ① 端点 `<circle r=2.8>` 被横向拉成椭圆（宽屏 7.8×2.8，一眼可见）；
 *   ② `<path strokeWidth=2.5>` 在非等比缩放下描边粗细随线段走向变化（越陡越粗、越平越细）。
 * 修法与 `WeightChart.tsx` 一致：`ResizeObserver` 实测容器宽度，`viewBox` 与渲染尺寸同值
 * （scaleX = scaleY = 1），并删掉 `preserveAspectRatio="none"`。
 *
 * ⚠️ **本测试的能力边界（重要，别高估）**：
 * jsdom **不做布局**（`getBoundingClientRect` / `contentRect` 恒为 0），所以这里**算不出真实
 * 的 scaleX**，也无法在断言里证明「圆是正圆」。本文件能钉住的只有三件事：
 *   1. 不再使用非等比缩放（`preserveAspectRatio="none"`）—— 这是「圆不变形」的**前提条件**；
 *   2. `viewBox` 的宽**等于** `<svg>` 的渲染宽 —— 此时 scaleX 恒为 1（与容器多宽无关）；
 *   3. 实测宽度真的流进了 `viewBox`（用假 ResizeObserver 喂一个非兜底宽度验证）。
 * 「圆是正圆、描边等粗」是这三条推出来的结论，不是断言本身 —— 真机/视觉回归仍需人眼确认。
 */
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Sparkline from '@/components/common/Sparkline';

/** 兜底宽度（与组件内 `FALLBACK_WIDTH` 一致）：jsdom 无 ResizeObserver 时走这条路径。 */
const FALLBACK_WIDTH = 260;
/** 组件内的水平内边距（padding）。 */
const PADDING = 8;

const DATA = [
  { date: '2026-09-01', weightKg: 60 },
  { date: '2026-09-02', weightKg: null },
  { date: '2026-09-03', weightKg: 59.4 },
  { date: '2026-09-04', weightKg: 59.1 },
  { date: '2026-09-05', weightKg: 58.8 },
  { date: '2026-09-06', weightKg: null },
  { date: '2026-09-07', weightKg: 58.2 },
];

/** 取唯一的 `<svg>` 元素。 */
function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg');
  if (svg === null) throw new Error('未渲染 svg');
  return svg;
}

/** `viewBox` 的四个数字。 */
function viewBoxOf(svg: SVGSVGElement): number[] {
  return (svg.getAttribute('viewBox') ?? '')
    .split(/\s+/)
    .filter((part) => part !== '')
    .map(Number);
}

/**
 * 喂给组件的假 ResizeObserver：`observe()` 时同步回调一次固定宽度。
 * 用来模拟「容器比兜底宽度更宽」的真实场景（jsdom 自身量不出宽度）。
 */
class FixedWidthResizeObserver implements ResizeObserver {
  constructor(
    private readonly callback: ResizeObserverCallback,
    private readonly width: number,
  ) {}

  observe(): void {
    const entries = [
      { contentRect: { width: this.width, height: 72 } },
    ] as unknown as ResizeObserverEntry[];
    this.callback(entries, this);
  }

  unobserve(): void {}

  disconnect(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sparkline · 等比缩放（圆是正圆、描边等粗）', () => {
  it('★ 不再用 preserveAspectRatio="none" 做非等比横向拉伸', () => {
    const { container } = render(<Sparkline data={DATA} />);
    const svg = svgOf(container);

    // 属性级断言：只要它还在，scaleX ≠ scaleY，圆必被拉成椭圆、描边粗细必随走向变化
    expect(svg.getAttribute('preserveAspectRatio')).toBeNull();
  });

  it('★ viewBox 宽 === <svg> 渲染宽（此时 scaleX 恒为 1，与容器多宽无关）', () => {
    const { container } = render(<Sparkline data={DATA} />);
    const svg = svgOf(container);
    const [, , vbWidth, vbHeight] = viewBoxOf(svg);

    // jsdom 无 ResizeObserver → 走兜底宽度
    expect(vbWidth).toBe(FALLBACK_WIDTH);
    expect(vbHeight).toBe(72);
    // 渲染宽度（px）与 viewBox 宽度同值 ⇒ 缩放比 = 1 ⇒ 圆是正圆
    expect(svg.getAttribute('width')).toBe(String(FALLBACK_WIDTH));
    expect(svg.getAttribute('height')).toBe('72');
  });

  it('★ 实测到的容器宽度流进 viewBox（容器比兜底宽时也不变形）', () => {
    // 模拟真实卡片内宽 328（≠ 兜底 260）：旧的 width="100%" + viewBox 260 在这里 scaleX ≈ 1.26
    vi.stubGlobal(
      'ResizeObserver',
      class extends FixedWidthResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          super(callback, 328);
        }
      },
    );

    const { container } = render(<Sparkline data={DATA} />);
    const svg = svgOf(container);
    const [, , vbWidth] = viewBoxOf(svg);

    expect(vbWidth).toBe(328);
    expect(svg.getAttribute('width')).toBe('328');

    // 端点圆没有横向溢出画布：x 落在 [padding, viewBox宽 - padding] 内
    const xs = Array.from(container.querySelectorAll('circle')).map((node) =>
      Number(node.getAttribute('cx')),
    );
    expect(xs.length).toBe(5);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(PADDING);
      expect(x).toBeLessThanOrEqual(328 - PADDING);
    }
  });

  it('圆半径仍是常量 2.8（不随容器宽度缩放）', () => {
    const { container } = render(<Sparkline data={DATA} />);
    const radii = Array.from(container.querySelectorAll('circle')).map((node) =>
      node.getAttribute('r'),
    );

    expect(radii.length).toBe(5);
    expect(new Set(radii)).toEqual(new Set(['2.8']));
  });
});
