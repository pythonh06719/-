import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { TOKENS } from '@/theme/tokens';

/**
 * 体重趋势图（pages/weight/WeightChart.tsx）。
 *
 * **原生 SVG 手写，零图表库依赖。** 曾用 ECharts（`echarts-for-react`）：一张
 * 两条线的趋势图却要额外下载约 338 KB(gzip) 的包，即便单独成 chunk 按需加载也不划算。
 * 此处只画实际用到的能力（两条平滑折线 + 坐标轴 + 网格 + 悬浮提示），
 * 包体降到数 KB 量级，并去掉 `echarts` / `echarts-for-react` 两个依赖。
 *
 * 由 `WeightPage` 动态导入（`React.lazy`）保留：不在首屏路径上，进一步减小主包。
 *
 * 两个系列：
 * - 「体重」：原始记录点（浅色，带数据点）
 * - 「7 日均线」：移动平均（深色、更粗、无点），弱化单日波动（TC-34）
 */

export interface WeightChartProps {
  /** 日期轴（`YYYY-MM-DD`） */
  dates: readonly string[];
  /** 原始体重序列 */
  weights: readonly number[];
  /** 7 日移动平均序列（与 `dates` 对齐，`null` 为断点） */
  movingAverage: ReadonlyArray<number | null>;
}

/** 绘图区内边距（与原 ECharts `grid` 逐值一致，保证观感不变）。 */
const PAD = { left: 40, right: 16, top: 24, bottom: 56 } as const;

/** 容器尺寸尚未测出（首次渲染 / 测试环境无 ResizeObserver）时的兜底画布。 */
const FALLBACK = { width: 600, height: 256 } as const;

/** 视觉令牌：取自设计令牌，与原 ECharts 版逐值一致。 */
const AXIS_COLOR = '#7d9489';
const GRID_COLOR = 'rgba(125,148,137,0.18)';
const WEIGHT_COLOR = TOKENS.brand[300];
const AVG_COLOR = TOKENS.brand[600];

/** y 轴分段数（含两端共 5 条网格线）。 */
const Y_SEGMENTS = 4;
/** x 轴最多显示的标签数，超出则等间隔抽稀。 */
const MAX_X_LABELS = 6;

/** 画布坐标点。 */
interface Point {
  x: number;
  y: number;
}

/** `YYYY-MM-DD` → `M/D`，横轴更省位。 */
function shortDate(iso: string): string {
  const parts = iso.split('-');
  const month = parts[1];
  const day = parts[2];
  if (month === undefined || day === undefined) return iso;
  return `${Number(month)}/${Number(day)}`;
}

/**
 * 把折线磨圆：相邻点之间用「以上一点为控制点、两点中点为终点」的二次贝塞尔，
 * 观感等价 ECharts 的 `smooth: true`，但代码只有几行。
 * `null`（或缺失）视为断点 —— 断成独立子路径，不跨断点连直线。
 */
function buildSmoothPath(points: ReadonlyArray<Point | null>): string {
  const segments: string[] = [];
  let current: Point[] = [];

  const flush = (): void => {
    const first = current[0];
    if (first === undefined) {
      current = [];
      return;
    }
    let d = `M ${first.x} ${first.y}`;
    for (let i = 1; i < current.length; i += 1) {
      const prev = current[i - 1];
      const point = current[i];
      if (prev === undefined || point === undefined) continue;
      d += ` Q ${prev.x} ${prev.y} ${(prev.x + point.x) / 2} ${(prev.y + point.y) / 2}`;
    }
    const last = current[current.length - 1];
    if (last !== undefined && current.length > 1) {
      d += ` L ${last.x} ${last.y}`;
    }
    segments.push(d);
    current = [];
  };

  for (const point of points) {
    if (point === null) {
      flush();
    } else {
      current.push(point);
    }
  }
  flush();
  return segments.join(' ');
}

export default function WeightChart({ dates, weights, movingAverage }: WeightChartProps): ReactElement {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>(FALLBACK);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // 容器实测尺寸：SVG 一律用像素坐标绘制，文字才不会随缩放变形。
  // 无 ResizeObserver 的环境（如 jsdom 测试）保持兜底尺寸。
  useEffect(() => {
    const node = boxRef.current;
    if (node === null || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined || rect.width <= 0 || rect.height <= 0) return;
      setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const count = dates.length;
  const plotWidth = Math.max(size.width - PAD.left - PAD.right, 1);
  const plotHeight = Math.max(size.height - PAD.top - PAD.bottom, 1);

  const geometry = useMemo(() => {
    const xAt = (index: number): number =>
      count <= 1 ? PAD.left + plotWidth / 2 : PAD.left + (plotWidth * index) / (count - 1);

    // y 轴范围。
    // 单数据点时收紧到 ±3（否则点会被压在默认区间中间）；多点用 min/max 加 8% 呼吸；
    // 所有值相等时兜底出一段非零跨度，避免除以 0。下限不出现负体重。
    const allValues: number[] = [];
    for (const value of weights) if (Number.isFinite(value)) allValues.push(value);
    for (const value of movingAverage) {
      if (value !== null && Number.isFinite(value)) allValues.push(value);
    }

    let minY = 0;
    let maxY = 1;
    const firstValue = allValues[0];
    if (firstValue !== undefined) {
      if (allValues.length === 1) {
        minY = Math.max(0, firstValue - 3);
        maxY = firstValue + 3;
      } else {
        let lo = firstValue;
        let hi = firstValue;
        for (const value of allValues) {
          if (value < lo) lo = value;
          if (value > hi) hi = value;
        }
        const span = hi - lo;
        const breathing = span === 0 ? Math.max(0.5, Math.abs(hi) * 0.02) : span * 0.08;
        minY = Math.max(0, lo - breathing);
        maxY = hi + breathing;
      }
    }

    const yAt = (value: number): number => PAD.top + ((maxY - value) / (maxY - minY)) * plotHeight;

    const weightPoints: Array<Point | null> = weights.map((value, index) =>
      Number.isFinite(value) ? { x: xAt(index), y: yAt(value) } : null,
    );
    const averagePoints: Array<Point | null> = movingAverage.map((value, index) =>
      value !== null && Number.isFinite(value) ? { x: xAt(index), y: yAt(value) } : null,
    );

    const ticks: number[] = [];
    for (let i = 0; i <= Y_SEGMENTS; i += 1) {
      ticks.push(minY + ((maxY - minY) * i) / Y_SEGMENTS);
    }

    // x 轴标签抽稀：最多 MAX_X_LABELS 个，并尽量让最后一个点也有标签。
    const step = Math.max(1, Math.ceil(count / MAX_X_LABELS));
    const labelIndices: number[] = [];
    for (let i = 0; i < count; i += step) labelIndices.push(i);
    const lastIndex = count - 1;
    const lastLabel = labelIndices[labelIndices.length - 1];
    if (lastIndex >= 0 && lastLabel !== undefined && lastLabel !== lastIndex) {
      if (lastIndex - lastLabel < step / 2) labelIndices.pop();
      labelIndices.push(lastIndex);
    }

    return {
      xAt,
      yAt,
      weightPoints,
      averagePoints,
      ticks,
      labelIndices,
      weightPath: buildSmoothPath(weightPoints),
      averagePath: buildSmoothPath(averagePoints),
    };
  }, [count, weights, movingAverage, plotWidth, plotHeight]);

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (count === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const ratio = count <= 1 ? 0 : (offsetX - PAD.left) / plotWidth;
    const index = Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
    setHoverIndex(index);
  };

  const hoverDate = hoverIndex === null ? null : (dates[hoverIndex] ?? null);
  const hoverWeight = hoverIndex === null ? null : (weights[hoverIndex] ?? null);
  const hoverAverage = hoverIndex === null ? null : (movingAverage[hoverIndex] ?? null);
  const hoverX = hoverIndex === null ? 0 : geometry.xAt(hoverIndex);

  const averageSummary = hoverAverage === null ? '暂无均线值' : `7 日均线 ${hoverAverage.toFixed(1)} kg`;

  return (
    <div ref={boxRef} className="relative h-full w-full">
      <svg
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${size.width} ${size.height}`}
        role="img"
        aria-label={
          count === 0
            ? '体重趋势折线图，暂无数据'
            : `体重趋势折线图，共 ${count} 个数据点，最新 ${(weights[count - 1] ?? 0).toFixed(1)} 公斤`
        }
        className="block touch-pan-y"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        {/* 水平网格线 + y 轴刻度 */}
        {geometry.ticks.map((tick) => {
          const y = geometry.yAt(tick);
          return (
            <g key={`y-${tick}`}>
              <line x1={PAD.left} y1={y} x2={size.width - PAD.right} y2={y} stroke={GRID_COLOR} strokeWidth={1} />
              <text x={PAD.left - 6} y={y} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={AXIS_COLOR}>
                {tick.toFixed(1)}
              </text>
            </g>
          );
        })}

        {/* x 轴日期标签 */}
        {geometry.labelIndices.map((index) => {
          const label = dates[index];
          if (label === undefined) return null;
          return (
            <text
              key={`x-${label}`}
              x={geometry.xAt(index)}
              y={size.height - PAD.bottom + 16}
              textAnchor="middle"
              fontSize={10}
              fill={AXIS_COLOR}
            >
              {shortDate(label)}
            </text>
          );
        })}

        {/* 7 日均线（更粗、更深的线压在下面） */}
        <path d={geometry.averagePath} fill="none" stroke={AVG_COLOR} strokeWidth={3} strokeLinecap="round" />

        {/* 体重曲线 */}
        <path d={geometry.weightPath} fill="none" stroke={WEIGHT_COLOR} strokeWidth={2} strokeLinecap="round" />

        {/* 体重记录点（直径 5，与原 `symbolSize: 5` 对齐） */}
        {geometry.weightPoints.map((point, index) =>
          point === null ? null : (
            <circle key={`p-${index}`} cx={point.x} cy={point.y} r={2.5} fill={WEIGHT_COLOR} />
          ),
        )}

        {/* 悬浮指示：竖线 + 高亮点 */}
        {hoverIndex !== null && hoverDate !== null && (
          <g>
            <line
              x1={hoverX}
              y1={PAD.top}
              x2={hoverX}
              y2={size.height - PAD.bottom}
              stroke={AXIS_COLOR}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {geometry.weightPoints[hoverIndex] !== null && geometry.weightPoints[hoverIndex] !== undefined && (
              <circle
                cx={geometry.weightPoints[hoverIndex].x}
                cy={geometry.weightPoints[hoverIndex].y}
                r={4}
                fill={WEIGHT_COLOR}
                stroke="#ffffff"
                strokeWidth={1.5}
              />
            )}
          </g>
        )}
      </svg>

      {/* 悬浮提示（HTML 层，避免 SVG 里排版文本） */}
      {hoverIndex !== null && hoverDate !== null && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-lg bg-slate-800/95 px-2.5 py-1.5 text-[11px] leading-tight text-white shadow-qsh-2 dark:bg-slate-700/95"
          style={{ left: Math.min(Math.max(hoverX, 64), Math.max(size.width - 64, 64)) }}
        >
          <p className="font-medium">{hoverDate}</p>
          {hoverWeight !== null && <p>{hoverWeight.toFixed(1)} kg</p>}
          <p className="text-slate-300 dark:text-slate-200">{averageSummary}</p>
        </div>
      )}

      {/* 图例 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-2 flex items-center justify-center gap-4 text-[11px] text-slate-600 dark:text-slate-300">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded-full" style={{ backgroundColor: WEIGHT_COLOR }} />
          体重
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[3px] w-4 rounded-full" style={{ backgroundColor: AVG_COLOR }} />
          7 日均线
        </span>
      </div>
    </div>
  );
}
