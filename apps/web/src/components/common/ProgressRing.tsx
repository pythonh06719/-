import { useId } from 'react';
import type { ReactElement } from 'react';
import { TOKENS } from '@/theme/tokens';

/**
 * 进度环（components/common/ProgressRing.tsx）—— 看板核心可视化（US-05 / R3.10）。
 *
 * **语气约束（PRD §7）**：绝不使用红色警示语义。
 * 超出 100% 时使用柔和的暖色（`coral`）渐进提示，环外文案保持中性。
 */

export interface ProgressRingProps {
  /** 进度比（0 ~ 1+，可超过 1） */
  value: number;
  /** 直径（px） */
  size?: number;
  /** 环宽（px） */
  strokeWidth?: number;
  /** 环内主文案（如百分比或剩余热量） */
  centerValue?: string;
  /** 环内副文案 */
  centerLabel?: string;
  /** 屏幕阅读器朗读文本；缺省由 `centerValue`/`centerLabel` 拼装 */
  ariaLabel?: string;
  /**
   * 深色模式。
   *
   * ⚠️ 曾经是可选 prop 且**两处调用点都没传**（`GoalProgressCard` / `OnboardingPage`），
   * 于是深色下拿到浅色渐变 —— 而底环那行 `dark ? '#24443a' : '#d9ede4'` 也跟着走错，
   * 深色下渲染成一条**浅色亮白圈**压在墨绿卡上，是本项目最深色的一类错。
   *
   * 现在**删掉这个 prop**，组件自己读 `<html>` 的 class。
   * 为什么删而不是改成必传：漏传一次就是静默走错色值，而这类 bug 只有在深色下才看得见，
   * 「等 QA 截图才发现」的成本远高于多写一行。`applyTheme()` 维护的正是这个 class
   * （`theme/useTheme.ts`），是全站深色态的唯一真源；底环则走 CSS 变量，两套主题自动成立。
   *
   * 若确实需要显式覆盖（例如打印视图），再把 prop 加回来 —— 但那时三处调用点都得显式传。
   */
}

/** 把任意数值限制到 [min, max]。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export default function ProgressRing({
  value,
  size = 176,
  strokeWidth = 14,
  centerValue,
  centerLabel,
  ariaLabel,
}: ProgressRingProps): ReactElement {
  const safeValue = Number.isFinite(value) ? value : 0;
  const ratio = clamp(safeValue, 0, 1);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);
  const overBudget = safeValue > 1;

  /**
   * 深色态直接读 `<html class>`。
   *
   * 为什么不用 `useTheme()`：那个 hook 读的是 localStorage 的**用户选择**（`mode`），
   * `mode === 'system'` 时 resolved 要靠 `prefers-color-scheme` 媒体查询二次判定；
   * 而这里要的是**屏幕上此刻真实的 class**（`applyTheme()` 已把它算好了）。
   * 读 class 也天然处理了「system 跟随系统变化」—— 无需本组件订阅媒体查询。
   *
   * SSR / 测试环境无 `document` 时按浅色处理（本项目是纯客户端 PWA，无 SSR 路径）。
   */
  const dark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  const gradientStops = dark ? TOKENS.progressGradientDark : TOKENS.progressGradient;
  /**
   * 渐变 id 必须逐实例唯一：原为硬编码常量 `qshProgressGradient`，
   * 同一页面渲染两个环（`GoalProgressCard` + `OnboardingPage` 各一处，
   * 但宽屏布局或未来复用会让同页出现两个）→ HTML id 重复，
   * `url(#...)` 会解析到文档里第一个，第二个环的渐变是错的。
   */
  const gradientId = `qshProgressGradient-${useId()}`;
  const strokeColor = overBudget ? TOKENS.coral[300] : `url(#${gradientId})`;
  const label = ariaLabel ?? `${centerLabel ?? '进度'} ${Math.round(safeValue * 100)}%`;

  return (
    // ⚠️ 根节点必须自带 `relative`：`centerValue`/`centerLabel` 那块是 `absolute` 居中，
    // 此前依赖调用方卡片恰好是定位上下文（`GoalProgressCard.tsx:64` 的注释已承认这个隐式前置条件）。
    // 组件自洽比让每个调用方都记得补一行更可靠。
    <div className="relative inline-flex items-center justify-center" role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={gradientStops[0]} />
            <stop offset="50%" stopColor={gradientStops[1]} />
            <stop offset="100%" stopColor={gradientStops[2]} />
          </linearGradient>
        </defs>
        {/* 底环：走 CSS 变量（浅 `#d9ede4` / 深 `#24443a`），与卡片描边同源。
            此前硬编码在此，且两处调用点都**没传 `dark`** → 深色下是一条浅色亮白圈。 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgb(var(--qsh-ring-track))"
          strokeWidth={strokeWidth}
        />
        {/* 进度环 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          /**
           * 数值过渡：此前**完全没有** `transition`，进度一变圆环就瞬跳 —— 这是本组件
           * 最明显的视觉缺陷（数值在滚，圆环在闪）。参数与体系对齐：
           * `duration-qsh-slow`(320ms) + `ease-qsh-out`，同 `VISUAL-SYSTEM §3` 的大块内容进出档。
           * `stroke-dashoffset` 是 SVG 几何属性而非 CSS 动画属性，但可被 transition 插值；
           * `prefers-reduced-motion` 由 `theme/a11y.css` 的全局规则关掉（它对 `*` 设 transition: none）。
           */
          style={{ transition: 'stroke-dashoffset 320ms cubic-bezier(.22,.68,.28,1)' }}
        />
      </svg>
      {(centerValue !== undefined || centerLabel !== undefined) && (
        <div className="pointer-events-none absolute flex flex-col items-center" aria-hidden="true">
          {centerValue !== undefined && (
            <span className="qsh-tnum text-display font-semibold text-slate-800 dark:text-slate-100">
              {centerValue}
            </span>
          )}
          {centerLabel !== undefined && (
            <span className="mt-1 text-caption text-slate-600 dark:text-slate-400">{centerLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}
