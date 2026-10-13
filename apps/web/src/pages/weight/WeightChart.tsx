import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import type { GoalForecastPoint, WeightUnit } from '@qsh/shared-types';
import { TOKENS } from '@/theme/tokens';
import { formatWeight, formatWeightNumber, toDisplayWeight, weightSpokenLabel } from '@/lib/units';

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
 * **x / y 轴均以「实际数据」为基准**，预测线只作参考、不得支配坐标轴：
 * - x 轴按真实时间映射（日期 → 毫秒），域 = `[实际最早日期, 实际最晚日期 + clamp(数据跨度×30%, 14, 56)天]`，
 *   且不超过预测终点；无未来预测时实际数据铺满全宽（观感与改动前一致）。预测线裁剪到域内。
 * - y 轴 = 实际 min/max ± 10%，纳入预测时允许外扩但不超过 `max(实际跨度×0.5, 3kg)`；预测线裁到域内。
 * - x 轴标签按**像素间距**（≥ 44px）抽稀，时间轴下不再重叠。
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
  /**
   * 体重展示单位（D-3）。
   *
   * ⚠️ **只影响文字标签**（y 轴刻度、悬浮提示、图例、读屏）；SVG 的几何坐标
   * 一律仍按 kg 计算 —— 换算在展示层做，坐标系不因单位而变（等价换算）。
   * 缺省 `kg`，便于测试直接渲染本组件时保持原观感。
   */
  unit?: WeightUnit;
}

/** 绘图区内边距（与原 ECharts `grid` 逐值一致，保证观感不变）。 */
const PAD = { left: 40, right: 16, top: 24, bottom: 56 } as const;

/** 容器尺寸尚未测出（首次渲染 / 测试环境无 ResizeObserver）时的兜底画布。 */
const FALLBACK = { width: 600, height: 256 } as const;

/**
 * 视觉令牌：取自设计令牌。
 *
 * ⭐ **全部改走 CSS 变量**（`styles/index.css :root` + `theme/dark.css html.dark` 覆盖），
 * 原因：SVG 的 `stroke` / `fill` 是 presentation attribute，**不吃 Tailwind 的 `dark:` 变体**
 * （那套机制是在元素上切 class）。此前这里是硬编码字面量，于是：
 *   ① 轴色 `#7d9489` 对白底 3.5:1，而轴标签只有 10px → 远低于 AA 的 4.5:1；
 *   ② 悬浮点用 `stroke="#ffffff"` 硬编码纯白，在深色下变成一个**亮白圈**；
 *   ③ 最严重的是**深色下主次反转**：`WEIGHT_COLOR` = brand-300（对 `#16241f` 9.33:1）
 *      比 `AVG_COLOR` = brand-600（3.79:1）亮 2.5 倍，而浅色下恰恰是 7 日均线（更粗、
 *      更深）才是主角 —— 「均线是主角」的设计意图在深色模式下完全失效。
 * 变量让同一个 `stroke` 在两套主题里各自成立，不需要为深色再写一套几何。
 */
const AXIS_COLOR = 'rgb(var(--qsh-axis))';
const GRID_COLOR = 'rgb(var(--qsh-grid))';
/** 实际体重线：浅色用 brand-300（最淡，让均线更重）；深色用 brand-400 —— 见下方 dark 分支 */
const WEIGHT_COLOR_LIGHT = TOKENS.brand[300];
/**
 * 深色档取 brand-400（`#4fbf94`）而非 brand-300（`#8cc9ab`）。
 *
 * ⚠️ 这是 2026-10-05 实测后的二次调整：第一版按「对调两档」的思路取了 brand-300，
 * 截图出来**两线仍然糊在一起** —— 因为 brand-300 是全色板最亮的一档，
 * 与同样明亮的均线（brand-300）之间几乎没有亮度差。
 * 现在深色下均线 = brand-300（最亮，主角）、实际线 = brand-400（暗一档，配角），
 * 「主角更亮 + 线更粗」两个维度同时成立，浅色深色才对得上。
 */
const WEIGHT_COLOR_DARK = TOKENS.brand[400];
/** 7 日均线：主角。深浅两套都用较重的一档，线宽也最大（3） */
const AVG_COLOR = TOKENS.brand[600];
/** 目标预测线：中性灰（不抢实际数据的视觉权重）。走 CSS 变量 —— 它不属于品牌色板，
 *  浅档 slate-400 `#94a3b8`（对白底 2.6:1，WCAG 对非文本线要求 ≥3:1，此处是「刻意最淡」，
 *  与文件原注释「不抢权重」一致）；深档提亮到 `#b6c4c0` 级别，深底上仍 ≥3:1。 */
const FORECAST_COLOR = 'rgb(var(--qsh-hairline))';

// --------------------------------------------------------------------------
// 深色态订阅（`useSyncExternalStore` 的 store）
// --------------------------------------------------------------------------

/** 读一次：`<html>` 上有没有 `dark` class。`applyTheme()`（`theme/useTheme.ts`）维护它。 */
function isDarkMode(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

/**
 * 订阅 `dark` class 的增删。
 *
 * 为什么用 `MutationObserver` 而不是主题层派发事件：
 * `applyTheme()` 是纯 DOM 操作（`classList.toggle`），**不派发任何事件**，
 * 也没有可订阅的 store。要让「渲染时读一次 class」的组件在切换时重渲染，
 * 观察那个 class 本身是最直接、且不要求主题层配合改动的做法。
 * 观察点挂在 `<html>` 的 `class` 属性上（`attributeFilter: ['class']`），
 * 避免为无关的 class 变动反复触发。
 */
function subscribeThemeClass(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** y 轴分段数（含两端共 5 条网格线）。 */
const Y_SEGMENTS = 4;
/** x 轴标签最小像素间距：小于此值即抽稀（按实际像素坐标去重，而非下标等间隔）。 */
const MIN_LABEL_GAP = 44;
/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** x 轴右端外扩天数的下限（数据时间跨度 × 30% 后 clamp 到 [14, 56] 天）。 */
const PAD_DAYS_MIN = 14;
/** x 轴右端外扩天数的上限。 */
const PAD_DAYS_MAX = 56;

/** 数值 clamp。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
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
  unit = 'kg',
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

  /**
   * 深浅两套线色在此分叉（其余色值走 CSS 变量，无需分叉）。
   *
   * 分叉的原因只有一个：**深色下不能让「实际线」比「均线」更亮**。
   * 浅色下均线（brand-600，线宽 3）是主角、实际线（brand-300，线宽 2）是配角；
   * 照搬到深色后 brand-300 对卡片底 `#16241f` 有 9.33:1，而 brand-600 只有 3.79:1 ——
   * 主次直接反转，读者第一眼看到的是原始抖动数据，而不是被平滑过的趋势。
   * 深色下把两档对调：均线用最亮的 brand-300、实际线降到 brand-400，与浅色的意图一致。
   *
   * ⭐ 为什么必须**订阅**而不是读一次（2026-10-05 实测踩到）：
   * 最初写成「渲染时读一次 `document.documentElement.classList`」，看起来能用 ——
   * 但那只是**渲染那一刻的快照**。用户在设置里切「深色」，`applyTheme()` 改了 class，
   * 而本组件不会重渲染，图表线色**停在旧主题**。
   * 同样的坑本轮取证脚本也踩了一次（截图全浅色却没报错）。
   * → 用 `useSyncExternalStore` 订阅 class 变化，它正是「外部 store 变了就重渲染」的正解。
   *   三个 SVG 组件里只有本组件需要分叉线色，另两个（ProgressRing / Sparkline）
   *   全部走 CSS 变量，深浅自动成立，不需要订阅。
   */
  const isDark = useSyncExternalStore(subscribeThemeClass, () => isDarkMode(), () => false);
  const WEIGHT_COLOR = isDark ? WEIGHT_COLOR_DARK : WEIGHT_COLOR_LIGHT;

  const geometry = useMemo(() => {
    // 只保留可解析日期 + 有效体重的预测点
    const validForecast: GoalForecastPoint[] = [];
    for (const point of forecast ?? []) {
      if (Number.isFinite(point.weightKg) && dateMs(point.date) !== null) {
        validForecast.push(point);
      }
    }

    // ---- x 轴：以「实际数据」为基准的时间域 ----
    // 若把预测终点也算进域，会按「目标创建日 ~ 预测终点」的整段放大，
    // 导致实际点被压缩到左侧一小条（QA R2.6 回归）。故右端只在数据跨度上有限外扩。
    const dataTimes: number[] = [];
    for (const iso of dates) {
      const ms = dateMs(iso);
      if (ms !== null) dataTimes.push(ms);
    }

    let dataMin = 0;
    let dataMax = 0;
    const firstTime = dataTimes[0];
    if (firstTime !== undefined) {
      let lo = firstTime;
      let hi = firstTime;
      for (const ms of dataTimes) {
        if (ms < lo) lo = ms;
        if (ms > hi) hi = ms;
      }
      dataMin = lo;
      dataMax = hi;
    }
    const dataSpanMs = dataMax - dataMin;
    const dataSpanDays = dataSpanMs / DAY_MS;
    // 右端外扩 = clamp(数据时间跨度 × 30%, 14 天, 56 天)
    const padMs = clamp(dataSpanDays * 0.3, PAD_DAYS_MIN, PAD_DAYS_MAX) * DAY_MS;

    // 预测起点 / 终点（可解析预测日期的最早 / 最晚）
    let forecastStart: number | null = null;
    let forecastEnd: number | null = null;
    for (const point of validForecast) {
      const ms = dateMs(point.date);
      if (ms === null) continue;
      if (forecastStart === null || ms < forecastStart) forecastStart = ms;
      if (forecastEnd === null || ms > forecastEnd) forecastEnd = ms;
    }

    const hasData = dataTimes.length > 0;
    let minX = 0;
    let maxX = 0;
    if (hasData) {
      if (dataSpanMs === 0) {
        // 单点：以该点为中心左右留白，避免点贴在边缘
        const half = padMs / 2;
        minX = dataMax - half;
        maxX = dataMax + half;
        // 仅当预测起点落在外扩窗口内时才外扩（否则只会留白）
        if (
          forecastEnd !== null &&
          forecastStart !== null &&
          forecastEnd > maxX &&
          forecastStart <= dataMax + padMs
        ) {
          maxX = Math.min(dataMax + padMs, forecastEnd);
        }
      } else if (forecastEnd !== null && forecastEnd > dataMax) {
        // 有未来预测，但**仅当「预测起点」落在外扩窗口内时才外扩** ——
        // 否则预测线全在窗口之外（如目标今天创建、最后一条记录在 40 天前），
        // 外扩只会留下右侧空白，反而压扁实际数据（QA P3）。外扩到 min(窗口末端, 预测终点)。
        const windowEnd = dataMax + padMs;
        minX = dataMin;
        maxX =
          forecastStart !== null && forecastStart <= windowEnd
            ? Math.min(windowEnd, forecastEnd)
            : dataMax;
      } else {
        // 无预测 / 预测已在过去：实际数据铺满全宽（与改动前观感一致）
        minX = dataMin;
        maxX = dataMax;
      }
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

    // 预测线 x 裁剪：只保留落在 [minX, maxX] 内的点（超出的直接丢弃，路径自然分段）
    const visibleForecast: GoalForecastPoint[] = [];
    for (const point of validForecast) {
      const ms = dateMs(point.date);
      if (ms !== null && ms >= minX && ms <= maxX) {
        visibleForecast.push(point);
      }
    }

    // ---- y 轴：同样以「实际数据」为基准 ----
    // 实际 min/max ± 10%；纳入预测时允许外扩，但不超过 max(实际跨度 × 0.5, 3kg)，
    // 否则预测线会把实际波动压成一条直线（QA R2.6 回归）。
    const actualValues: number[] = [];
    for (const value of weights) if (Number.isFinite(value)) actualValues.push(value);
    for (const value of movingAverage) {
      if (value !== null && Number.isFinite(value)) actualValues.push(value);
    }

    let actualMin = 0;
    let actualMax = 1;
    const firstValue = actualValues[0];
    if (firstValue !== undefined) {
      let lo = firstValue;
      let hi = firstValue;
      for (const value of actualValues) {
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      actualMin = lo;
      actualMax = hi;
    }

    const span = actualMax - actualMin;
    const padding = span === 0 ? 3 : span * 0.1;
    const maxExpand = span === 0 ? 3 : Math.max(span * 0.5, 3);
    let minY = actualMin - padding;
    let maxY = actualMax + padding;
    for (const point of visibleForecast) {
      if (point.weightKg < minY) minY = Math.max(point.weightKg, actualMin - maxExpand);
      if (point.weightKg > maxY) maxY = Math.min(point.weightKg, actualMax + maxExpand);
    }
    minY = Math.max(0, minY);

    const yAt = (value: number): number => PAD.top + ((maxY - value) / (maxY - minY)) * plotHeight;

    const weightPoints: Array<Point | null> = weights.map((value, index) =>
      Number.isFinite(value) ? { x: xAt(index), y: yAt(value) } : null,
    );
    const averagePoints: Array<Point | null> = movingAverage.map((value, index) =>
      value !== null && Number.isFinite(value) ? { x: xAt(index), y: yAt(value) } : null,
    );
    // 预测线 y 裁剪：超出 y 域的点丢弃
    const forecastPoints: Point[] = [];
    for (const point of visibleForecast) {
      if (point.weightKg >= minY && point.weightKg <= maxY) {
        forecastPoints.push({ x: xAtDate(point.date), y: yAt(point.weightKg) });
      }
    }

    const ticks: number[] = [];
    for (let i = 0; i <= Y_SEGMENTS; i += 1) {
      ticks.push(minY + ((maxY - minY) * i) / Y_SEGMENTS);
    }

    // x 轴标签抽稀：按**已算出的像素坐标**去重（与上一个保留标签间距 < MIN_LABEL_GAP 即丢弃），
    // 首尾标签优先保留。不再用「下标等间隔」——时间轴下会导致标签重叠（QA R2.6 回归）。
    const labelIndices: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const x = xAt(i);
      const previous = labelIndices[labelIndices.length - 1];
      if (previous === undefined || x - xAt(previous) >= MIN_LABEL_GAP) {
        labelIndices.push(i);
      }
    }
    const lastIndex = count - 1;
    const lastLabel = labelIndices[labelIndices.length - 1];
    if (lastIndex >= 0 && lastLabel !== undefined && lastLabel !== lastIndex) {
      const lastX = xAt(lastIndex);
      while (labelIndices.length > 0) {
        const keptIndex = labelIndices[labelIndices.length - 1];
        if (keptIndex === undefined || lastX - xAt(keptIndex) >= MIN_LABEL_GAP) break;
        labelIndices.pop();
      }
      labelIndices.push(lastIndex);
    }

    // 预测线至少 2 个点才可见（单点只是 `M`，无实际线段）
    const hasForecast = forecastPoints.length >= 2;

    // 目标值（预测曲线末端 = 目标体重），供图例展示
    let targetKg: number | null = null;
    for (const point of validForecast) {
      if (Number.isFinite(point.weightKg)) targetKg = point.weightKg;
    }

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
      targetKg,
    };
  }, [dates, count, weights, movingAverage, forecast, plotWidth, plotHeight]);

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    // 只跟随「真有指针设备」的悬停：触屏的 pointermove 会在手指停住时持续触发，
    // 而抬起手指不保证触发 pointerleave → 提示会「粘」在图上不消失（同一类移动端伪影，
    // 与 `.qsh-action-card` 的 hover 保护同理）。触屏用户直接看趋势线即可。
    if (event.pointerType !== 'mouse' || count === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    // 时间轴下按「最近的实际记录点」取整（不再假设等距下标）。距离超过「半个点距」
    // 视为落在点云之外的空白区 → 清除提示（避免悬停左侧空白时跳到某个点）。
    let nearest = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i += 1) {
      const distance = Math.abs(geometry.xAt(i) - offsetX);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = i;
      }
    }
    const spread = count > 1 ? Math.abs(geometry.xAt(count - 1) - geometry.xAt(0)) : plotWidth;
    const halfSpacing = Math.max(spread / Math.max(count - 1, 1) / 2, 12);
    setHoverIndex(nearestDistance > halfSpacing ? null : nearest);
  };

  const hoverDate = hoverIndex === null ? null : (dates[hoverIndex] ?? null);
  const hoverWeight = hoverIndex === null ? null : (weights[hoverIndex] ?? null);
  const hoverAverage = hoverIndex === null ? null : (movingAverage[hoverIndex] ?? null);
  const hoverX = hoverIndex === null ? 0 : geometry.xAt(hoverIndex);

  const averageSummary =
    hoverAverage === null ? '暂无均线值' : `7 日均线 ${formatWeight(hoverAverage, unit)}`;

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
            : `体重趋势折线图，共 ${count} 个数据点，最新 ${formatWeightNumber(weights[count - 1], unit)} ${weightSpokenLabel(unit)}${
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
              <text x={PAD.left - 6} y={y} textAnchor="end" dominantBaseline="middle" fontSize={11} fill={AXIS_COLOR}>
                {toDisplayWeight(tick, unit).toFixed(1)}
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
              fontSize={11}
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

        {/*
         * 7 日均线：主角。**画在实际线之下**，线宽 3 且颜色最深 ——
         * 「主角更粗 + 颜色更深 + 位置在下层」三个维度同时成立，
         * 局部交叉时也不会被实际线盖掉。
         */}
        <path d={geometry.averagePath} fill="none" stroke={AVG_COLOR} strokeWidth={3} strokeLinecap="round" />

        {/* 实际体重线：配角。线宽 2（比均线细一档） */}
        <path d={geometry.weightPath} fill="none" stroke={WEIGHT_COLOR} strokeWidth={2} strokeLinecap="round" />

        {/*
         * 体重记录点：**半径从 2.5 收到 1.6**。
         *
         * ⚠️ 这是 2026-10-05 截图实测发现的：原 r=2.5（直径 5，与当年 ECharts
         * `symbolSize: 5` 对齐）的圆点**比均线的半宽 1.5 还大**，等于把配角画成了主角 ——
         * 一屏 90 个圆点密密麻麻压着均线，两线在局部糊成一片，主次彻底读不出来。
         * 圆点的作用只是「标出记录位置」，不需要抢视觉重量；1.4 已足够看清
         * （比均线半宽 1.5 小，且与 2px 线宽比例协调），一屏 90 个点也不再糊成一片。
         * 视觉上现在是：均线最粗最深在下层，实际线次之，数据点最轻。
         */}
        {geometry.weightPoints.map((point, index) =>
          point === null ? null : (
            <circle key={`p-${index}`} cx={point.x} cy={point.y} r={1.4} fill={WEIGHT_COLOR} />
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
                stroke="rgb(var(--qsh-surface-ring))"
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
          className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-control bg-slate-800/95 px-2.5 py-1.5 text-caption leading-tight text-white shadow-qsh-2 dark:bg-slate-700/95"
          style={{ left: Math.min(Math.max(hoverX, 64), Math.max(size.width - 64, 64)) }}
        >
          <p className="font-medium">{hoverDate}</p>
          {hoverWeight !== null && <p>{formatWeight(hoverWeight, unit)}</p>}
          <p className="text-slate-300 dark:text-slate-200">{averageSummary}</p>
        </div>
      )}

      {/* 图例 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-2 flex items-center justify-center gap-4 text-caption text-slate-600 dark:text-slate-300">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded-pill" style={{ backgroundColor: WEIGHT_COLOR }} />
          体重
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[3px] w-4 rounded-pill" style={{ backgroundColor: AVG_COLOR }} />
          7 日均线
        </span>
        {geometry.hasForecast && (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block w-4"
              style={{ borderTop: `2px dashed ${FORECAST_COLOR}` }}
            />
            {geometry.targetKg === null
              ? '目标预测'
              : `目标预测（目标 ${formatWeight(geometry.targetKg, unit)}）`}
          </span>
        )}
      </div>
    </div>
  );
}
