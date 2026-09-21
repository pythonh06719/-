import type { ReactElement } from 'react';

/**
 * 品牌装饰（components/common/BrandDecor.tsx）。
 *
 * 「轻生活」的视觉母题是**一朵五瓣小花 + 草叶**（花心为暖黄），来自首屏加载页。
 *
 * ⚠️ 为什么这里与 `index.html` 各有一份，而不合并：
 * 加载页在**首屏 HTML 里内联**绘制（必须随 HTML 一起到达、不能等 JS 包加载完成，
 * 否则首屏会先空白再长花）。它无法从 TS 模块引入，所以那份留在 HTML 内联；
 * 本组件负责 **App 运行期**的装饰场景（页头角饰、空状态等）。
 * 两者是同一套造型语言的**两处有意实现**，不是重复代码 —— 改动造型时请同步两处。
 *
 * 约束（都为了「装饰不干扰内容」）：
 * - `aria-hidden` + `focusable="false"`：纯装饰，不进可访问性树、不可键盘聚焦；
 * - `pointer-events-none`：不拦截点击，绝不遮挡下层控件；
 * - 颜色一律走 `currentColor`，由调用方的 `text-*` 决定 —— 组件内不写死色值，
 *   因此在深色模式下自动跟随主题；
 * - 尺寸由调用方 `className` 里的 `w-*` / `h-*` 控制，组件内不写死。
 */

/** 三种造型：角饰 / 草叶 / 正面花。 */
export type BrandDecorVariant = 'corner' | 'leaf' | 'bloom';

export interface BrandDecorProps {
  /** 造型，默认 `bloom`（正面小花） */
  variant?: BrandDecorVariant;
  /** 尺寸与颜色（如 `h-6 w-6 text-brand-300`） */
  className?: string;
}

export default function BrandDecor({ variant = 'bloom', className }: BrandDecorProps): ReactElement {
  /**
   * 共同属性：统一在 40×40 画布上绘制，调用方只改外框尺寸即可等比缩放。
   * `strokeLinecap/Join` 用 round → 草叶与花瓣的转折处柔软，符合「温和」基调。
   */
  const common = {
    viewBox: '0 0 40 40',
    'aria-hidden': true,
    // 字面量收窄：SVG 的 focusable 只接受 boolean 或 'true'/'false' 字面量
    focusable: 'false' as const,
    className: `pointer-events-none ${className ?? ''}`.trim(),
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  /** 五瓣 + 花心：五个圆按 72° 均分排布，与加载页花瓣同构。 */
  const petals = (cx: number, cy: number, scale = 1): ReactElement => (
    <g transform={`translate(${cx} ${cy}) scale(${scale})`}>
      <circle cx="0" cy="-5.4" r="5.2" />
      <circle cx="4.9" cy="-0.8" r="5.2" />
      <circle cx="3" cy="5" r="5.2" />
      <circle cx="-3" cy="5" r="5.2" />
      <circle cx="-4.9" cy="-0.8" r="5.2" />
      <circle cx="0" cy="0" r="2.6" />
    </g>
  );

  if (variant === 'leaf') {
    // 一簇草叶：三片高低错落，根部收在同一点，用于分隔或点缀
    return (
      <svg {...common}>
        <path d="M20 34c0-9-3-15-9-21" />
        <path d="M20 34c0-12 2-19 6-26" />
        <path d="M20 34c3-6 7-9 12-11" />
        <path d="M20 34v-6" />
      </svg>
    );
  }

  if (variant === 'corner') {
    // 角饰：一枚略倾斜的花 + 短茎，重心偏右上，放在页头角落不抢视线
    return (
      <svg {...common}>
        <g transform="rotate(16 24 14)">
          {petals(24, 14, 0.82)}
        </g>
        <path d="M22.5 20.5c-1.6 3.2-2.4 6.4-2.6 10" />
        <path d="M20.4 25.6c-2.2-.6-3.9-1.8-5.2-3.6" />
      </svg>
    );
  }

  // bloom：正面小花 + 茎 + 双叶（空状态用；形态与加载页那朵完全一致）
  return (
    <svg {...common}>
      <path d="M20 40V21" />
      <ellipse cx="13.5" cy="28" rx="6" ry="3.2" transform="rotate(-25 13.5 28)" />
      <ellipse cx="26.5" cy="32" rx="5.5" ry="3" transform="rotate(22 26.5 32)" />
      {petals(20, 12.6)}
    </svg>
  );
}
