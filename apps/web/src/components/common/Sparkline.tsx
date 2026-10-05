import { useEffect, useState, type ReactElement } from 'react';
import type { WeightUnit } from '@qsh/shared-types';
import { formatWeightNumber, weightSpokenLabel } from '@/lib/units';

/**
 * 迷你趋势图（components/common/Sparkline.tsx）。
 *
 * 纯 SVG 实现（不依赖图表库），用于看板最近 7 天体重迷你趋势；
 * `null` 视为断点（该日无记录），不连线、不补零（诚实呈现，避免误导）。
 *
 * ⚠️ 几何坐标一律按 kg 绘制（仅形状，不显示数值）；只有读屏标签里的「最新 X」
 * 会按 `weightUnit` 换算（D-3）—— 换算只是等价显示，不改变数据。
 *
 * ⭐ **画布宽度必须实测，不能用百分比横向拉伸**（2026-10 修）：
 * 此前是 `width="100%"` + `viewBox="0 0 260 72"` + `preserveAspectRatio="none"`，
 * 于是 scaleX = 容器宽 / 260（移动端卡片≈1.26，宽屏 `max-w-3xl` 可达 2.8）、scaleY 恒为 1：
 *   ① 端点 `<circle r=2.8>` 被拉成椭圆（宽屏 7.8×2.8，肉眼可见）；
 *   ② `<path strokeWidth=2.5>` 在非等比缩放下描边粗细随线段走向变化（越陡越粗、越平越细）。
 * 现在按 `WeightChart.tsx` 的既有模式：用 `ResizeObserver` 实测容器宽度，
 * 并让 `viewBox` 与渲染尺寸**同值**（scaleX = scaleY = 1），删掉 `preserveAspectRatio="none"`。
 */

export interface SparklineProps {
  /** 数据点（按时间升序；`null` 表示当日无记录） */
  data: ReadonlyArray<{ date: string; weightKg: number | null }>;
  /** 宽度（px）；**仅作缺省 / 兜底值** —— 实测到容器宽度后一律以实测值为准 */
  width?: number;
  /** 高度（px） */
  height?: number;
  /** 无障碍标签 */
  ariaLabel?: string;
  /** 体重展示单位（D-3，仅影响读屏标签里的数值口径）；缺省 `kg` */
  weightUnit?: WeightUnit;
}

/** 兜底画布宽度（px）：容器尚未测出宽度 / 环境无 `ResizeObserver`（如 jsdom）时使用。 */
const FALLBACK_WIDTH = 260;

export default function Sparkline({
  data,
  // ⚠️ 命名说明：这个 prop 的语义是「没有实测值时用多宽」，不是「最终画多宽」。
  // 实测宽度是下面的 `measuredWidth`，最终画布宽度是 `viewWidth`（= 实测值，测不到才退回本值）。
  // 三者分开命名，避免把「我想要的宽度」和「容器实际给我的宽度」混成一个变量。
  width: fallbackWidth = FALLBACK_WIDTH,
  height = 72,
  ariaLabel = '最近体重趋势',
  weightUnit = 'kg',
}: SparklineProps): ReactElement {
  /**
   * 被测量的容器节点，用 **callback ref 存进 state**（不是 `useRef`）。
   *
   * ⚠️ 为什么不能用 `useRef`：`numeric.length < 2` 时走的是下面的占位分支，
   * 那时**根本没有 `<figure>`** —— `ref.current` 是 null，effect 直接返回。
   * 而看板冷启动恰好是这条路径（`DashboardPage` 的兜底 dashboard `miniTrend: []`），
   * 数据到达后 `<figure>` 才挂载，可 effect 的依赖是 `[]`、**再也不会重跑** →
   * `viewWidth` 永久停在兜底的 260px（实测桌面端卡片内宽约 187px，会溢出约 73px）。
   * callback ref 让「节点挂载」本身成为依赖，分支切换后能重新 observe。
   */
  const [box, setBox] = useState<HTMLElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number>(fallbackWidth);

  // 容器实测宽度：SVG 一律按像素坐标绘制（viewBox 与渲染尺寸同值），
  // 圆才是正圆、描边才等粗。无 ResizeObserver 的环境（如 jsdom 测试）保持兜底宽度。
  useEffect(() => {
    if (box === null || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined || rect.width <= 0) return;
      setMeasuredWidth(rect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);

  const numeric = data.filter(
    (point): point is { date: string; weightKg: number } => point.weightKg !== null,
  );

  if (numeric.length < 2) {
    return (
      <div
        className="flex h-[72px] items-center justify-center rounded-xl bg-brand-50 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-400"
        style={{ width: '100%' }}
      >
        记录几笔体重后，这里会出现趋势
      </div>
    );
  }

  /** 实际画布宽度（px）：实测优先，测不到才用兜底；下限 1 避免退化成 0 宽。 */
  const viewWidth = Math.max(measuredWidth > 0 ? measuredWidth : fallbackWidth, 1);

  const weights = numeric.map((point) => point.weightKg);
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  const span = max - min === 0 ? 1 : max - min;
  const padding = 8;
  const stepX = (viewWidth - padding * 2) / Math.max(data.length - 1, 1);

  // 以「原始索引」定位 x，保证时间轴连续（缺失日留空）
  const coordinates = new Map<string, { x: number; y: number }>();
  data.forEach((point, index) => {
    if (point.weightKg === null) {
      return;
    }
    const x = padding + index * stepX;
    const y =
      height - padding - ((point.weightKg - min) / span) * (height - padding * 2);
    coordinates.set(point.date, { x, y });
  });

  const path = numeric
    .map((point, index) => {
      const coordinate = coordinates.get(point.date);
      if (coordinate === undefined) {
        return '';
      }
      return `${index === 0 ? 'M' : 'L'} ${coordinate.x.toFixed(1)} ${coordinate.y.toFixed(1)}`;
    })
    .join(' ');

  const latest = numeric[numeric.length - 1];

  return (
    <figure className="w-full" ref={(node) => setBox(node)}>
      <svg
        width={viewWidth}
        height={height}
        viewBox={`0 0 ${viewWidth} ${height}`}
        role="img"
        aria-label={`${ariaLabel}，最新 ${latest === undefined ? '—' : formatWeightNumber(latest.weightKg, weightUnit)} ${weightSpokenLabel(weightUnit)}`}
        className="block"
      >
        {/* 趋势线走 CSS 变量（浅 `--qsh-spark` = brand-600 / 深 = brand-300）。
            此前硬编码 `#2f9e78` = brand-500，**对白底只有 3.34:1** —— VISUAL-SYSTEM §4
            已把它判为偏弱档（焦点环用的 brand-600 是 4.72:1）。SVG 的 stroke 不吃 `dark:`
            变体，变量是让它在两套主题里各自成立的唯一机制。 */}
        <path
          d={path}
          fill="none"
          stroke="rgb(var(--qsh-spark))"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
        {numeric.map((point) => {
          const coordinate = coordinates.get(point.date);
          if (coordinate === undefined) {
            return null;
          }
          return (
            <circle
              key={point.date}
              cx={coordinate.x}
              cy={coordinate.y}
              r={2.8}
              fill="rgb(var(--qsh-spark))"
            />
          );
        })}
      </svg>
      <figcaption className="sr-only">
        最近 {data.length} 天体重趋势，共 {numeric.length} 笔记录
      </figcaption>
    </figure>
  );
}
