import type { ReactElement } from 'react';
import DerivationRow from '../DerivationRow';
import type { WhySectionProps } from './types';

/**
 * ⑤ 目标进度与维持模式怎么判断（R2.7）。
 *
 * 2026-10-12（P2-4 注册表化）：从 `WhyNumbersPage.tsx` 整体迁出，JSX 逐字未改。
 * 选它做专用组件而非数据化：它的第二块是 `<ul><li>` 卡片（品牌色底 + strong 标题 + xs 正文），
 * 与其余条目的「为什么」`<dl>`（dt/dd 纯文本）不同构 —— 混进同一张数据模型会多养一个
 * 只服务一个条目的分支。结构不同构就走专用组件，与 ①②③ 同规则。
 */
export default function GoalProgressSection({ id, title }: WhySectionProps): ReactElement {
  return (
    <section
      aria-labelledby={id}
      className="qsh-surface p-5"
    >
      <h2 id={id} className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </h2>
      <p className="mt-tight text-sm text-slate-600 dark:text-slate-300">
        体重页那个环只回答两件事：你走到哪儿了，大概还要多久。算不出来的时候，我们宁可整张卡片不显示，
        也不给你一个假数字。
      </p>
      <dl className="mt-block rounded-control bg-brand-50 p-4 dark:bg-brand-900/40">
        <DerivationRow term="进度基准" value="目标历史里最早一条的起始体重" hint="= 设定目标时的体重" />
        <DerivationRow term="达成比" value="(基准 − 最新) ÷ (基准 − 目标)" hint="钳制到 0~100%" />
        <DerivationRow
          term="为什么不用「当前起始体重」"
          value="它会被「记录体重」同步成最新体重"
          hint="当基准会让进度恒为 0%"
        />
        <DerivationRow term="还需几周" value="引擎 etaWeeks = 剩余(kg) ÷ 每周有效减重" hint="展示时向上取整" />
        <DerivationRow term="维持模式" value="最新体重 ≤ 目标体重 → 不再制造缺口" hint="摄入回到 TDEE" />
      </dl>
      <ul className="mt-block space-y-2 text-sm text-slate-600 dark:text-slate-300">
        <li className="rounded-control bg-brand-50 px-4 py-3 dark:bg-brand-900/30">
          <strong className="text-brand-800 dark:text-brand-200">到了目标之后，我们不再催你往下走</strong>
          <p className="mt-0.5 text-xs text-brand-700 dark:text-brand-100">
            达成目标后，引擎会把缺口收敛到 0、建议摄入回到 TDEE，页面也切换成「已经到啦 + 维持热量」，
            不再显示「还需几周」。继续压低热量，不是我们推荐的做法。
          </p>
        </li>
        <li className="rounded-control bg-brand-50 px-4 py-3 dark:bg-brand-900/30">
          <strong className="text-brand-800 dark:text-brand-200">算不出来的时候，就整张卡片不显示</strong>
          <p className="mt-0.5 text-xs text-brand-700 dark:text-brand-100">
            没有生效目标、或资料不足以重算预算时，进度卡不会出现 ——
            与其显示一个 0% 的空档让人对着发呆，不如什么都不说。
          </p>
        </li>
      </ul>
    </section>
  );
}
