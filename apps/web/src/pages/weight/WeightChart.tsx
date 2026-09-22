import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import type { GoalForecastPoint } from '@qsh/shared-types';
import { TOKENS } from '@/theme/tokens';

/**
 * 体重趋势图（pages/weight/WeightChart.tsx）。
 *
 * **原生 SVG 手写，零图表库依赖。** 曾用 ECharts（`echarts-for-react`）：一张
 * 两条线的趋势图却要额外下载约 338 KB(gzip) 的包，即便单独成 chunk 按需加载也不划算。
 * 此处只画实际用到的能力（多条折线 + 坐标轴 + 网格 + 悬浮提示），
 * 包体降到数 KB 量级，并去掉 `echarts` / `echarts-for-react` 两个依赖。
 *
 * 由 `WeightPage` 动态导入（`React.lazy`）保留：不在首屏路径上，进一步减小主包。
 *
 * 三个系列：
 * - 「体重」：原始记录点（浅色，带数据点）
 * - 「7 日均线」：移动平均（深色、更粗、无点），弱化单日波动（TC-34）
 * - 「目标预测」（R2.6，可选）：由 `@qsh/core` 纯函数生成的匀速下降**虚线**（中性色、无点）
 *
 * **x 轴按真实时间映射**（日期 → 毫秒），实际点与预测点共用同一 `[min, max]` 域 ——
 * 比「按数组下标等距」更正确：日期跳空 / 预测延伸到未来时，横轴间距与真实时间一致。
 */

export interface WeightChartProps {
  /** 日期轴（`YYYY-MM-DD`） */
  dates: readonly string[];
  /** 原始体重序列 */
  weights: readonly number[];
  /** 7 日移动平均序列（与 `dates` 对齐，`null` 为断点） */
  movingAverage: ReadonlyArray<number | null>;
  /** 目标达成预测曲线（R2.6，可选；为空 / 未传时不绘制预测线） */
  forecast?: ReadonlyArray<GoalForecastPoint>;
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
/** 目标预测线：中性灰（不抢实际数据的视觉权重）。 */
const FORECAST_COLOR = '#94a3b8';

/** y 轴分段数（含两端共 5 条网格线）。 */
const Y_SEGMENTS = 4;
/** x 轴最多显示的标签数，超出则等间隔抽稀。 */
const MAX_X_LABELS = 6;
/** `YYYY-MM-DD` 形态（宽松：允许 1~2 位月/日）。 */
const DATE_KEY_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

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

/** `YYYY-MM-DD` → **本地**当天 00:00 的毫秒时间戳；非法时返回 `null`。 */
function dateMs(iso: string): number | null {
  const matched = DATE_KEY_PATTERN.exec(iso);
  if (matched === null) return null;
  const ms = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])).getTime();
  return Number.isNaN(ms) ? null : ms;
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

export default function WeightChart({
  dates,
  weights,
  movingAverage,
  forecast,
}: WeightChartProps): ReactElement {
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
    // 只保留可解析日期 + 有效体重的预测点
    const validForecast: GoalForecastPoint[] = [];
    for (const point of forecast ?? []) {
      if (Number.isFinite(point.weightKg) && dateMs(point.date) !== null) {
        validForecast.push(point);
      }
    }

    // x 轴时间域：实际记录日期与预测日期共用同一 [min, max]，右端自然延伸到预测终点。
    const timeValues: number[] = [];
    for (const iso of dates) {
      const ms = dateMs(iso);
      if (ms !== null) timeValues.push(ms);
    }
    for (const point of validForecast) {
      const ms = dateMs(point.date);
      if (ms !== null) timeValues.push(ms);
    }

    let minX = 0;
    let maxX = 0;
    const firstX = timeValues[0];
    if (firstX !== undefined) {
      let lo = firstX;
      let hi = firstX;
      for (const ms of timeValues) {
        if (ms < lo) lo = ms;
        if (ms > hi) hi = ms;
      }
      minX = lo;
      maxX = hi;
    }

    const centerX = PAD.left + plotWidth / 2;
    const xAtMs = (ms: number): number =>
      maxX === minX ? centerX : PAD.left + (plotWidth * (ms - minX)) / (maxX - minX);
    const xAtDate = (iso: string): number => {
      const ms = dateMs(iso);
      return ms === null ? centerX : xAtMs(ms);
    };
    const xAt = (index: number): number => {
      const iso = dates[index];
      return iso === undefined ? centerX : xAtDate(iso);
    };

    // y 轴范围。
    // 单数据点时收紧到 ±3（否则点会被压在默认区间中间）；多点用 min/max 加 8% 呼吸；
    // 所有值相等时兜底出一段非零跨度，避免除以 0。下限不出现负体重。
    // **必须包含预测体重**，否则预测线会跑出绘图区。
    const allValues: number[] = [];
    for (const value of weights) if (Number.isFinite(value)) allValues.push(value);
    for (const value of movingAverage) {
      if (value !== null && Number.isFinite(value)) allValues.push(value);
    }
    for (const point of validForecast) allValues.push(point.weightKg);

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
    const forecastPoints: Point[] = validForecast.map((point) => ({
      x: xAtDate(point.date),
      y: yAt(point.weightKg),
    }));

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

    // 预测线至少 2 个点才可见（单点只是 `M`，无实际线段）
    const hasForecast = forecastPoints.length >= 2;

    return {
      xAt,
      yAt,
      weightPoints,
      averagePoints,
      forecastPoints,
      ticks,
      labelIndices,
      weightPath: buildSmoothPath(weightPoints),
      averagePath: buildSmoothPath(averagePoints),
      forecastPath: hasForecast ? buildSmoothPath(forecastPoints) : '',
      hasForecast,
    };
  }, [dates, count, weights, movingAverage, forecast, plotWidth, plotHeight]);

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    // 只跟随「真有指针设备」的悬停：触屏的 pointermove 会在手指停住时持续触发，
    // 而抬起手指不保证触发 pointerleave → 提示会「粘」在图上不消失（同一类移动端伪影，
    // 与 `.qsh-action-card` 的 hover 保护同理）。触屏用户直接看趋势线即可。
    if (event.pointerType !== 'mouse' || count === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    // 时间轴下按「最近的实际记录点」取整（不再假设等距下标）
    let nearest = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i += 1) {
      const distance = Math.abs(geometry.xAt(i) - offsetX);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = i;
      }
    }
    setHoverIndex(nearest);
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
            : `体重趋势折线图，共 ${count} 个数据点，最新 ${(weights[count - 1] ?? 0).toFixed(1)} 公斤${
                geometry.hasForecast ? '，含目标达成预测线' : ''
              }`
        }
        className="block touch-pan-y"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        {/* 水平网格线 + y 轴刻度 */}
        {geometry.ticks.map((tick, tickIndex) => {
          const y = geometry.yAt(tick);
          return (
            <g key={`y-${tickIndex}`}>
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
              key={`x-${index}`}
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

        {/* 目标预测线（R2.6）：中性色虚线、垫在最下层、无数据点 */}
        {geometry.hasForecast && (
          <path
            d={geometry.forecastPath}
            fill="none"
            stroke={FORECAST_COLOR}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="6 5"
          />
        )}

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

      {/* 悬浮提示（HTML 层，避免在 SVG 里排版文本）。
          刻意 **不** 用 `aria-live`：它是跟随鼠标高频更新的视觉增强，
          进 live region 会让屏幕阅读器被反复打断；整体数据已由 svg 的 aria-label 概括。 */}
      {hoverIndex !== null && hoverDate !== null && (
        <div
          aria-hidden="true"
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
        {geometry.hasForecast && (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block w-4"
              style={{ borderTop: `2px dashed ${FORECAST_COLOR}` }}
            />
            目标预测
          </span>
        )}
      </div>
    </div>
  );
}
