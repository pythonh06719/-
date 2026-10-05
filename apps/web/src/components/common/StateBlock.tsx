import type { ReactElement, ReactNode } from 'react';

/**
 * 加载 / 失败占位块（components/common/StateBlock.tsx）。
 *
 * 存在的理由：**同一条「正在读数据」的提示此前在 4 个文件里各写了一份**，且都写成
 * `rounded-2xl bg-white p-6 text-center text-sm text-slate-500 shadow-sm`。
 * 两处问题：
 * ① `p-6` 与真实卡片的 `p-5` 不一致 —— 数据到位那一刻整块「变形」，用户会以为
 *    页面结构变了；
 * ② 用 `.qsh-surface` 的手写复刻（`bg-white` + `shadow-sm` + 各自补 `dark:`），
 *    阴影档位与描边各写各的，深色下也容易漏。
 *
 * 这里统一走 `.qsh-surface`（自带 elevation-1、描边、深色自动成立）+ `p-5`，
 * 与同视图真实卡片几何一致 → 切换时只有内容变化，没有尺寸跳动。
 *
 * `min-h-[96px]`：给一个稳定的最小高度，避免「一行字 → 一张卡」的高度跳变，
 * 同时让短文案在栅格里也不会显得空。
 *
 * 无障碍：`role="status"` + `aria-live="polite"` 让读屏在数据到位时播报；
 * 文字对比度按 AA 选色（`text-slate-600` / `dark:text-slate-300` ≥ 4.5:1）。
 */

export interface StateBlockProps {
  /** 提示文案（由调用方从 `COPY` 取，本组件不自带任何句子） */
  children: ReactNode;
  /** 保留调用方既有的测试锚点 */
  'data-testid'?: string;
  /** 额外类名（尺寸微调等，默认已具备居中与最小高度） */
  className?: string;
}

export default function StateBlock({
  children,
  className,
  ...rest
}: StateBlockProps): ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`qsh-surface flex min-h-[96px] items-center justify-center p-5 text-center text-body text-slate-600 dark:text-slate-300 ${className ?? ''}`.trim()}
      {...rest}
    >
      {children}
    </div>
  );
}