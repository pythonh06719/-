import type { ReactElement } from 'react';

/**
 * 分段控件（components/common/SegmentedControl.tsx，2026-10-12 UI 评审 P1）。
 *
 * ## 为什么抽它
 *
 * 全站原有**三种**「同一时刻只选一个」的 tab 皮肤，选中态语义各不相同：
 * ① `/report`（ReportTabs）—— pill 实心 brand-600；② `/ai` —— 白底 + shadow-sm；
 * ③ `/diary` 记录方式（MealComposer）—— pill 实心但未选态是 brand-50。
 * 同语义组件三种皮肤，新页面会继续发明第四种。本组件以 ReportTabs 范式为基准
 * （视觉权重最合适：选中态明确、未选态边界立得住），三处全部收敛到它。
 *
 * ## 契约（调用方必须遵守）
 *
 * - **a11y 结构固定**：`role="tablist"` / `role="tab"` / `aria-selected`，
 *   多项测试按 role + 可访问名定位 tab（如 `getByRole('tab', { name: COPY.topFoodsTab })`），
 *   故 label 必须原样透传、顺序由 `items` 决定，本组件不做任何排序或过滤。
 * - **选中态唯一真源**：`bg-brand-600 text-white`；未选态 `bg-white + ring-1 ring-brand-100`。
 *   调用方不得再自写按钮类名——那等于复发三种皮肤。
 * - **容器只出 `flex gap-1.5`**：横滑（`overflow-x-auto`）、换行（`flex-wrap`）、
 *   等分（`grid-cols-*` 时调用方传 `grid` 覆盖）等布局差异由 `className` 决定，
 *   避免组件内堆布局变体。
 *
 * ## dense 是什么
 *
 * `px-4 → px-3` 的唯一合法使用者是 MealComposer：其 6 项默认 tab 在 375px 下
 * `px-4` 合计 364px > 可用 350px 会被迫横滑，`px-3` 的 342px 是「默认免横滑」
 * 精算值（见 MealComposer 该处注释）。除此之外**不要传 dense**。
 */

export interface SegmentedItem<T extends string> {
  key: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  items: ReadonlyArray<SegmentedItem<T>>;
  value: T;
  onChange: (key: T) => void;
  /** tablist 的无障碍名称（如「回顾范围」「记录方式」） */
  ariaLabel: string;
  /** 容器附加类名：布局差异（横滑 / 换行 / 外边距）在这里传，组件只负责 flex 与间距 */
  className?: string;
  /** 紧凑密度（px-3）：仅限有 375px 精算的横滑 tab 组，见上方说明 */
  dense?: boolean;
}

export default function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className,
  dense = false,
}: SegmentedControlProps<T>): ReactElement {
  return (
    <div role="tablist" aria-label={ariaLabel} className={`flex gap-1.5${className ? ` ${className}` : ''}`}>
      {items.map((item) => (
        <button
          key={item.key}
          role="tab"
          type="button"
          aria-selected={value === item.key}
          onClick={() => onChange(item.key)}
          className={[
            'qsh-touch-target shrink-0 rounded-pill text-sm transition-colors duration-qsh-fast ease-qsh-out',
            dense ? 'px-3' : 'px-4',
            value === item.key
              ? 'bg-brand-600 text-white'
              : // 未选中态用「白底 + brand 描边」：与页底 brand-50 同色的旧写法（MealComposer）
                // 会让 tab 融进背景；白底 + 细环边界立得住，且与选中态形成明确对比。
                'bg-white text-slate-600 ring-1 ring-brand-100 dark:bg-slate-800 dark:text-slate-300',
          ].join(' ')}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
