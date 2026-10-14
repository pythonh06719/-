import type { ReactElement } from 'react';
import { TOKENS } from '@/theme/tokens';
import { COPY, reportTrendAria } from '@/lib/copy';
import StateBlock from '@/components/common/StateBlock';

/**
 * 「摄入 vs 运动」迷你柱状对比（pages/report/IntakeExerciseChart.tsx，C2）。
 *
 * **零图表库**：手写 SVG（思路同 `components/common/Sparkline.tsx`）——
 * 一张对比图不值得再引一个几百 KB 的依赖。
 *
 * 每天两根柱：摄入（品牌色）/ 运动（暖中性色，**不是**红色），
 * 柱高统一按「7 天内的峰值」缩放，因此两组可直接目视对比。
 *
 * 无障碍：SVG 带 `role="img"` + 汇总 `aria-label`（两周合计）；
 * 逐日精确数值由 `ReportPage` 的可见明细列表给出，故此处不重复堆 `sr-only` 内容。
 *
 * 空数据（无任何记录）时不画空轴，直接给一句中性说明 —— 与产品「不用空图制造焦虑」一致。
 */

export interface IntakeExerciseChartProps {
  /** 每日数据（按日期升序；通常 7 天） */
  days: ReadonlyArray<{ date: string; intakeKcal: number; exerciseKcal: number }>;
}

/** 视图宽度（与 `viewBox` 一致；实际宽度由容器 100% 拉伸）。 */
const VIEW_W = 340;
/** 柱体区域高度。 */
const VIEW_H = 96;
/** 底部基线预留。 */
const BASELINE_GAP = 2;

/**
 * 基线色：走 `--qsh-hairline` CSS 变量（浅 `#cbd5e1` / 深 `#3f5a50`）。
 *
 * ⚠️ 此前这里硬编码 `rgba(125,148,137,0.35)` —— 全仓唯一一处「活的」SVG 色值
 * 绕过变量机制（同族的 WeightChart / Sparkline / ProgressRing 全走
 * `rgb(var(--qsh-*))`）。后果是深色模式下这条线**糊掉**：0.35 透明度的灰绿
 * 叠在深卡面 `#16241f` 上合成约 `#3a4b44`，对底只有 ~1.5:1，柱子像悬在空中。
 * 变量注释里本就点名「图表内的细分割线（如运动量柱的基线）」，接回即修。
 */
const BASELINE_COLOR = 'rgb(var(--qsh-hairline))';

function safe(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export default function IntakeExerciseChart({ days }: IntakeExerciseChartProps): ReactElement {
  const intakeTotal = days.reduce((sum, day) => sum + safe(day.intakeKcal), 0);
  const exerciseTotal = days.reduce((sum, day) => sum + safe(day.exerciseKcal), 0);

  if (days.length === 0) {
    return (
      <StateBlock className="lg:col-span-2">{COPY.reportTrendEmpty}</StateBlock>
    );
  }

  // 峰值 = 两组里的最大单日值；全为 0 时兜底为 1，避免除零（柱高即为 0，如实呈现）
  const peak = Math.max(1, ...days.map((day) => Math.max(safe(day.intakeKcal), safe(day.exerciseKcal))));

  const plotH = VIEW_H - BASELINE_GAP;
  const baseline = VIEW_H - BASELINE_GAP;
  const groupW = VIEW_W / days.length;
  const barW = Math.max(2, groupW * 0.3);
  const innerGap = Math.max(1, groupW * 0.08);
  const groupInner = barW * 2 + innerGap;
  const heightOf = (value: number): number => (safe(value) / peak) * plotH;

  return (
    <figure className="w-full">
      <svg
        width="100%"
        height={VIEW_H}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        // ⚠️ 这里的非等比横向拉伸（scaleX = 容器宽 / 340、scaleY = 1）**目前无害**，
        // 因为图元只有 `<rect>`（柱子横向变宽正是期望行为）和一条水平 `<line>`
        // （scaleY = 1，描边不受影响），日期标签也刻意用 HTML 渲染绕开变形。
        // 但它是 `Sparkline.tsx` 同一个缺陷的活化石：谁往这里加一个 `<circle>` 或斜线
        // —— 圆会被拉成椭圆、斜线描边粗细会随走向变化。要加，请改成实测容器宽度、
        // viewBox 与渲染尺寸同值（照 `WeightChart.tsx` 的 ResizeObserver 模式）。
        preserveAspectRatio="none"
        role="img"
        aria-label={reportTrendAria(intakeTotal, exerciseTotal)}
        className="block"
      >
        {/* 基线 */}
        <line
          x1={0}
          y1={baseline}
          x2={VIEW_W}
          y2={baseline}
          stroke={BASELINE_COLOR}
          strokeWidth={1}
        />
        {days.map((day, index) => {
          const groupLeft = index * groupW;
          const startX = groupLeft + (groupW - groupInner) / 2;
          const intakeH = heightOf(day.intakeKcal);
          const exerciseH = heightOf(day.exerciseKcal);
          return (
            <g key={`${index}-${typeof day.date === 'string' ? day.date : ''}`}>
              <rect
                x={startX}
                y={baseline - intakeH}
                width={barW}
                height={intakeH}
                fill={TOKENS.brand[400]}
              />
              <rect
                x={startX + barW + innerGap}
                y={baseline - exerciseH}
                width={barW}
                height={exerciseH}
                fill={TOKENS.coral[300]}
              />
            </g>
          );
        })}
      </svg>

      {/* 日期标签用 HTML 呈现：SVG 用 `preserveAspectRatio="none"` 横向拉伸，文字放进 SVG 会变形 */}
      <div
        className="mt-tight grid text-caption text-slate-600 dark:text-slate-400"
        style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
        aria-hidden="true"
      >
        {days.map((day, index) => (
          <span key={`${index}-${typeof day.date === 'string' ? day.date : ''}`} className="text-center">
            {typeof day.date === 'string' && day.date.length >= 5 ? day.date.slice(5) : '—'}
          </span>
        ))}
      </div>

      <figcaption className="mt-1.5 flex items-center justify-center gap-4 text-caption text-slate-600 dark:text-slate-300">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: TOKENS.brand[400] }}
            aria-hidden="true"
          />
          {COPY.reportIntakeSeries}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: TOKENS.coral[300] }}
            aria-hidden="true"
          />
          {COPY.reportExerciseSeries}
        </span>
      </figcaption>
    </figure>
  );
}
