import type { ReactElement } from 'react';
import type { WhySectionProps } from './types';

/**
 * ③ 数据来源与许可（`/why-numbers` 第 3 条）。
 *
 * 2026-10-12（P2-4 注册表化）：从 `WhyNumbersPage.tsx` 整体迁出，JSX 逐字未改。
 * 选它做专用组件而非数据化：食物来源表 + 单位说明两块的排版与推导行不同构。
 */
export default function DataSourceSection({ id, title }: WhySectionProps): ReactElement {
  return (
    <section
      aria-labelledby={id}
      className="qsh-surface p-5"
    >
      <h2 id={id} className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </h2>
      <p className="mt-tight text-sm text-slate-600 dark:text-slate-300">
        食物库共 1773 条，逐条标注来源与许可；代码为 MIT，数据是混合来源（详见仓库 DATA-LICENSE.md）。
        其中《中国食物成分表》扩量条目仅限个人非商业自用，不参与对外分发。
      </p>
      <table className="mt-block w-full border-collapse text-sm">
        <caption className="sr-only">食物营养数据来源与许可</caption>
        <thead>
          <tr className="text-left text-xs text-slate-600 dark:text-slate-300">
            <th scope="col" className="py-1 font-medium">来源</th>
            <th scope="col" className="py-1 text-right font-medium">条数</th>
            <th scope="col" className="py-1 font-medium">许可</th>
          </tr>
        </thead>
        <tbody className="text-slate-700 dark:text-slate-200">
          <tr className="border-t border-slate-100 dark:border-slate-700">
            <td className="py-1.5">本项目自建（依《中国食物成分表》等公开资料整理）</td>
            <td className="qsh-tnum py-1.5 text-right">57</td>
            <td className="py-1.5">CC BY 4.0</td>
          </tr>
          <tr className="border-t border-slate-100 dark:border-slate-700">
            <td className="py-1.5">Open Food Facts（包装食品）</td>
            <td className="qsh-tnum py-1.5 text-right">258</td>
            <td className="py-1.5">ODbL 1.0（须署名）</td>
          </tr>
          <tr className="border-t border-slate-100 dark:border-slate-700">
            <td className="py-1.5">USDA FoodData Central（SR Legacy，中文译名与归类由本项目完成）</td>
            <td className="qsh-tnum py-1.5 text-right">128</td>
            <td className="py-1.5">公有领域</td>
          </tr>
          <tr className="border-t border-slate-100 dark:border-slate-700">
            <td className="py-1.5">《中国食物成分表》（个人非商业自用，不参与对外分发）</td>
            <td className="qsh-tnum py-1.5 text-right">1330</td>
            <td className="py-1.5">个人非商业自用</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-block text-xs text-slate-600 dark:text-slate-300">
        署名：© Open Food Facts contributors（ODbL 1.0）；USDA FoodData Central — SR Legacy（公有领域）。
        《中国食物成分表》数据未经中国营养学会/中国疾控中心营养与健康所书面允许不得用于商业目的，本项目仅个人非商业自用、不再分发。
      </p>

      <h3 className="mt-4 text-sm font-semibold text-slate-800 dark:text-slate-100">单位说明</h3>
      <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">
        <li>热量默认用 <strong className="text-slate-800 dark:text-slate-100">kcal（千卡）</strong>：1 kcal ≈ 4.184 kJ。</li>
        <li>顶栏可切换 kcal / kJ，换算只影响显示，不改变底层数据。</li>
        <li>食物营养一律按「每 100 克」记录，克数换算为 每100g 数值 × 克数 ÷ 100。</li>
        <li>饮水按毫升（ml），体重按千克（kg），运动时长按分钟。</li>
      </ul>
    </section>
  );
}
