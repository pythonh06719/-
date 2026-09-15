import type { ReactElement, ReactNode } from 'react';

/**
 * 分期占位组件（components/common/PhasePlaceholder.tsx）。
 *
 * 一期未开发的页面（`/exercise`、`/habits`、`/tools`、`/fasting`、`/report`、`/ai`）
 * 统一复用本组件：**文案友好、标注分期**，不出现生硬的「未实现」字眼（T04 交付要求）。
 */

export interface PhasePlaceholderProps {
  /** 页面标题 */
  title: string;
  /** 分期标注（如 `二期` / `三期`） */
  phase: string;
  /** 一句话介绍这个页面将带来什么 */
  description: string;
  /** 计划中的能力要点 */
  highlights?: readonly string[];
  /** 附加操作区（可选） */
  children?: ReactNode;
}

export default function PhasePlaceholder({
  title,
  phase,
  description,
  highlights = [],
  children,
}: PhasePlaceholderProps): ReactElement {
  return (
    <section className="mx-auto max-w-xl px-5 py-10" aria-labelledby="phase-placeholder-title">
      <p className="inline-block rounded-full bg-brand-100 px-3 py-1 text-xs font-medium text-brand-700 dark:bg-brand-900 dark:text-brand-200">
        {phase} · 即将到来
      </p>
      <h1
        id="phase-placeholder-title"
        className="mt-4 text-2xl font-semibold text-slate-900 dark:text-slate-100"
      >
        {title}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        {description}
      </p>

      {highlights.length > 0 && (
        <ul className="mt-5 space-y-2">
          {highlights.map((item) => (
            <li
              key={item}
              className="qsh-surface rounded-2xl px-4 py-3 text-sm text-slate-700 dark:text-slate-200"
            >
              {item}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-xs text-slate-400 dark:text-slate-500">
        我们正在按计划打磨，先把最有用的部分做扎实。你现在的记录不会受影响。
      </p>

      {children}
    </section>
  );
}
