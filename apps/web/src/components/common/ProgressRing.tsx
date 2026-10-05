import { useId, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { TOKENS } from '@/theme/tokens';

/**
 * 深色态订阅：进度环的**渐变**要按主题换（`progressGradient` / `progressGradientDark`），
 * 而 SVG 的 `stop-color` 是 presentation attribute，**不吃 Tailwind 的 `dark:` 变体**，
 * 也没法写成 CSS 变量（渐变停靠点要具体色值）—— 所以只能在 JS 里分叉。
 *
 * ⭐ 关键点：必须**订阅**而非「渲染时读一次」（2026-10-05 实测踩到）。
 * 原实现是 `document.documentElement.classList.contains('dark')` 直接在渲染体里读 ——
 * 那是**渲染那一刻的快照**。用户在顶栏点「深色」，`applyTheme()` 改了 class，
 * 而本组件不会重渲染 → 渐变停在旧主题。
 * 「删掉 dark prop」只解决了「调用方漏传」，没解决「主题切换后不重绘」——
 * 两个是独立的缺陷，缺一个都会让深色失效。
 *
 * 用 `useSyncExternalStore` 订阅 `dark` class 的增删：观察点挂在 `<html>` 的 class 属性上。
 * 之所以用 `MutationObserver` 而不等主题层派发事件：`applyTheme()`（`theme/useTheme.ts`）
 * 是纯 DOM 操作，不派发事件、也没有可订阅的 store —— 观察 class 本身最直接。
 */
function isDarkMode(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

function subscribeThemeClass(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

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
   * 深色态：**订阅**而来（理由见文件头）。`serverSnapshot` 给 `false` ——
   * 本项目是纯客户端 PWA，无 SSR 路径，这个值只在测试的初次渲染里用到。
   */
  const dark = useSyncExternalStore(subscribeThemeClass, isDarkMode, () => false);

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
