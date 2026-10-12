import type { ReactElement } from 'react';
import { MET_ACTIVITY_LIBRARY } from '@qsh/core';
import DerivationRow from '../DerivationRow';
import type { WhySectionProps } from './types';

/**
 * ② 运动消耗怎么算（`/why-numbers` 第 2 条）。
 *
 * 2026-10-12（P2-4 注册表化）：从 `WhyNumbersPage.tsx` 整体迁出，JSX 逐字未改。
 */

/** MET 示例：取前若干个内置运动，按 60kg / 30 分钟展示换算（复用 core 的 MET 表）。 */
const MET_SAMPLES = MET_ACTIVITY_LIBRARY.slice(0, 5).map((item) => ({
  name: item.name,
  met: item.met,
  kcalFor30minAt60kg: Math.round(item.met * 60 * 0.5),
}));

/** 「公式示例」用内置「快走」实测值，保证与 MET 表一致（不写死可能漂移的数字）。 */
const MET_EXAMPLE = (() => {
  const brisk = MET_ACTIVITY_LIBRARY.find((item) => item.code === 'walking_brisk');
  const met = brisk?.met ?? 5;
  return { met, kcalFor30minAt60kg: Math.round(met * 60 * 0.5) };
})();

export default function ExerciseSection({ id, title }: WhySectionProps): ReactElement {
  return (
    <section
      aria-labelledby={id}
      className="qsh-surface p-5"
    >
      <h2 id={id} className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </h2>
      <p className="mt-tight text-sm text-slate-600 dark:text-slate-300">
        用运动医学通用的 MET 公式（MET = 代谢当量），数值来自《2024 成人活动 MET 汇编》，与后端是同一份表。
      </p>
      <dl className="mt-block rounded-control bg-brand-50 p-4 dark:bg-brand-900/40">
        <DerivationRow term="公式" value="kcal = MET × 体重(kg) × 时长(小时)" />
        <DerivationRow
          term="示例"
          value={`快走 MET ${MET_EXAMPLE.met} × 60kg × 0.5h ≈ ${MET_EXAMPLE.kcalFor30minAt60kg} kcal`}
        />
      </dl>
      <table className="mt-block w-full border-collapse text-sm">
        <caption className="sr-only">常见运动的 MET 值与换算示例（60kg / 30 分钟）</caption>
        <thead>
          <tr className="text-left text-xs text-slate-600 dark:text-slate-300">
            <th scope="col" className="py-1 font-medium">运动</th>
            <th scope="col" className="py-1 text-right font-medium">MET</th>
            <th scope="col" className="py-1 text-right font-medium">约消耗（60kg / 30 分钟）</th>
          </tr>
        </thead>
        <tbody className="text-slate-700 dark:text-slate-200">
          {MET_SAMPLES.map((item) => (
            <tr key={item.name} className="border-t border-slate-100 dark:border-slate-700">
              <td className="py-1.5">{item.name}</td>
              <td className="qsh-tnum py-1.5 text-right">{item.met}</td>
              <td className="qsh-tnum py-1.5 text-right">{item.kcalFor30minAt60kg} kcal</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-block text-xs text-slate-600 dark:text-slate-300">
        运动消耗是估算值：实际还受强度、效率、体质影响，所以我们会说「大约」。别把它当精确账本。
      </p>
    </section>
  );
}
