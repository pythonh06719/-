import type { ReactElement } from 'react';
import DerivationRow from '../DerivationRow';
import type { SimpleSectionContent, WhySectionProps } from './types';

/**
 * 结构统一的条目渲染器（`/why-numbers` 的 ④、⑥…㉖ 共 22 条）。
 *
 * 这 22 条的页面结构完全一致，只有内容不同：
 *
 * ```
 * <section qsh-surface>
 *   <h2 id>编号 + 标题</h2>            ← id/title 由 why-sections.ts 真源经 props 传入
 *   [引导段 p]                        ← intro（可选）
 *   <dl 推导行>                        ← rows（可选；④ 没有）
 *   [<dl 「为什么」块>]                ← reasons（可选）
 *   [结尾提示 p]                       ← note（可选）
 * </section>
 * ```
 *
 * 内容因此可以纯数据化（见 `simple-sections.tsx`）：**加一条 = 加一个数据对象 +
 * 注册表里一行**，不再是在千行 JSX 里找地方插拔。①②③⑤ 因含表格 / 实时计算 /
 * 卡片式补充说明、结构不同构，仍用专用组件（⑤ 见 `GoalProgressSection`，其余见
 * `BudgetSection` / `ExerciseSection` / `DataSourceSection`）。
 *
 * 2026-10-12（P2-4 注册表化）新增。
 */
export default function SimpleSection({
  id,
  title,
  content,
}: WhySectionProps & { readonly content: SimpleSectionContent }): ReactElement {
  // 「为什么」块的上边距：有推导行时与其它条目一致用 mt-block（12px）；
  // 没有推导行时（仅 ④）用 mt-2（8px）—— 与原逐字 JSX 保持一致，不悄悄改间距。
  const reasonsMargin = content.rows === undefined ? 'mt-2' : 'mt-block';
  return (
    <section aria-labelledby={id} className="qsh-surface p-5">
      <h2 id={id} className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </h2>
      {content.intro !== undefined && (
        <p className="mt-tight text-sm text-slate-600 dark:text-slate-300">{content.intro}</p>
      )}
      {content.rows !== undefined && (
        <dl className="mt-block rounded-control bg-brand-50 p-4 dark:bg-brand-900/40">
          {content.rows.map((row) => (
            <DerivationRow key={row.term} term={row.term} value={row.value} hint={row.hint} />
          ))}
        </dl>
      )}
      {content.reasons !== undefined && (
        <dl className={`${reasonsMargin} space-y-3 text-sm`}>
          {/*
            key 用下标：reason.title 是 ReactNode（JSX 元素），没有可稳定字符串化的身份；
            而本列表是模块级静态数据、永不重排也不增删（增删 = 改代码发版），
            下标键在这里不会造成状态错乱。
          */}
          {content.reasons.map((reason, index) => (
            <div key={index}>
              <dt className="font-semibold text-slate-800 dark:text-slate-100">{reason.title}</dt>
              <dd className="mt-0.5 text-slate-600 dark:text-slate-300">{reason.body}</dd>
            </div>
          ))}
        </dl>
      )}
      {content.note !== undefined && (
        <p className="mt-4 rounded-control bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          {content.note}
        </p>
      )}
    </section>
  );
}
