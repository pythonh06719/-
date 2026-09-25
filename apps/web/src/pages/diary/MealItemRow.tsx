import type { ReactElement } from 'react';
import type { MealLog, MealType } from '@qsh/shared-types';
import { COPY, mealMoveDownAria, mealMoveSelectAria, mealMoveToAria, mealMoveUpAria } from '@/lib/copy';
import { emojiForFoodName } from '@/lib/food-emoji';
import { MEAL_TYPE_LABELS } from './meal-utils';

/**
 * 单条饮食记录（pages/diary/MealItemRow.tsx，R3.8）。
 *
 * **★ 降级控件是本组件的一等公民（AC-3.8.7 一票否决项）**：
 * 「上移 / 下移 / 移动到某餐」三个控件**不依赖拖拽 hook** ——
 * 即使 `usePointerReorder` 整个不挂载（拖拽不可用 / 测试环境 / 触屏不便长按），
 * 这一组按钮也照常工作，屏幕阅读器能读出完整语句（如「把「番茄炒蛋」移动到午餐」）。
 *
 * 边界处理：索引越界时用 `disabled` 而**不隐藏**控件，
 * 避免读屏用户发现控件凭空消失（AC-3.8.7）。
 *
 * ⚠️ 拖拽期间**不显示、不修改任何热量数字**（AC-3.8.2 / 无负罪感红线）——
 * 本组件只按传入的 `log` 原样渲染，顺序变化不改变任何营养值。
 *
 * ## UI 规范自检（`docs/VISUAL-SYSTEM.md`）
 * - 触控：所有可点元素（手柄 / 删除 / 上移 / 下移 / 移动到…）一律 `qsh-touch-target`（≥44×44）；
 * - 圆角 / 动效：用语义令牌 `rounded-control`、`duration-qsh-base` + `ease-qsh-out`，不写数值；
 * - 对比度：12px（`text-xs`）文字统一 `slate-600` / `dark:slate-300`（§5 的 12px 约束），
 *   拖拽中的状态环用 `brand-500` / `dark:brand-400`（对底色 ≥3:1，WCAG 1.4.11）；
 * - 状态：默认 / hover（`enabled:hover`，禁用时不给反馈）/ disabled（**保留控件、仅降透明度**）/ busy（`aria-busy`）；
 * - 焦点：不自定义，继承 `theme/a11y.css` 的 2px + 2px 偏移品牌环；
 * - 动效偏好：本组件只有颜色 / 阴影过渡，无位移动画；`prefers-reduced-motion` 由全局规则兜底。
 */

export interface MealItemRowProps {
  /** 本条记录 */
  log: MealLog;
  /** 展示名称（已由父组件解析：`customName ?? 食物库名称 ?? 兜底`） */
  name: string;
  /** 热量展示文本（含单位，由父组件按单位设置格式化） */
  kcalLabel: string;
  /** 克数后缀（`null` 时不展示） */
  gramsLabel: string | null;
  /** 是否可上移（本餐第一条时为 false → `disabled`，不隐藏） */
  canMoveUp: boolean;
  /** 是否可下移（本餐最后一条时为 false → `disabled`） */
  canMoveDown: boolean;
  /** 可选移动到的其它餐次（含中文标签） */
  otherMeals: ReadonlyArray<{ mealType: MealType; label: string }>;
  /** 删除 */
  onRemove: (id: number) => void;
  /** 上移（与本餐前一条交换） */
  onMoveUp: (id: number) => void;
  /** 下移（与本餐后一条交换） */
  onMoveDown: (id: number) => void;
  /** 移动到目标餐（追加到目标餐末尾） */
  onMoveTo: (id: number, mealType: MealType) => void;
  /**
   * 拖拽手柄的 `onPointerDown`（**可选增强**）。
   * 不传时只隐藏手柄，降级控件照常工作。
   */
  onDragHandlePointerDown?: (event: React.PointerEvent, id: number) => void;
  /** 该条是否正在被拖拽（仅做视觉反馈：抬起 + 描边） */
  dragging?: boolean;
  /** 注册该条的 DOM（供拖拽命中检测）；可选 */
  itemRef?: (element: HTMLElement | null) => void;
  /** 是否禁用全部移动控件（离线提交中等）；默认 false */
  busy?: boolean;
}

export default function MealItemRow({
  log,
  name,
  kcalLabel,
  gramsLabel,
  canMoveUp,
  canMoveDown,
  otherMeals,
  onRemove,
  onMoveUp,
  onMoveDown,
  onMoveTo,
  onDragHandlePointerDown,
  dragging = false,
  itemRef,
  busy = false,
}: MealItemRowProps): ReactElement {
  return (
    <li
      ref={itemRef}
      data-testid={`meal-item-${log.id}`}
      aria-busy={busy}
      className={[
        'rounded-control px-3 py-2 ring-1 ring-brand-100 transition duration-qsh-base ease-qsh-out dark:ring-slate-700',
        // 拖拽中的状态：elevation-3 抬升 + 品牌环（`brand-500` 对白底 3.34:1 / `brand-400` 对深底 6.42:1）
        dragging ? 'shadow-qsh-3 ring-2 ring-brand-500 dark:ring-brand-400' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* 拖拽手柄：纯指针增强，`aria-hidden` —— 等价操作由下方按钮组提供（AC-3.8.7） */}
          {onDragHandlePointerDown !== undefined && (
            <span
              aria-hidden="true"
              data-testid={`meal-drag-handle-${log.id}`}
              onPointerDown={(event) => onDragHandlePointerDown(event, log.id)}
              style={{ touchAction: 'none' }}
              className="qsh-touch-target shrink-0 cursor-grab select-none px-1 text-base text-slate-500 dark:text-slate-400"
              title={COPY.reorderGuide}
            >
              ⋮⋮
            </span>
          )}
          <span aria-hidden="true" className="text-lg">
            {emojiForFoodName(log.customName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm text-slate-800 dark:text-slate-100">{name}</p>
            <p className="qsh-tnum text-xs text-slate-600 dark:text-slate-300">
              {kcalLabel}
              {gramsLabel !== null ? ` · ${gramsLabel}` : ''}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onRemove(log.id)}
          className="qsh-touch-target shrink-0 rounded-control px-3 text-xs text-slate-600 hover:text-coral-600 dark:text-slate-300"
          aria-label={`删除 ${name}`}
        >
          删除
        </button>
      </div>

      {/* 降级控件组（AC-3.8.7）：上移 / 下移 / 移动到某餐。
          与拖拽**等价**、**独立** —— 拖拽 hook 不挂载时这一组照常可用。 */}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={!canMoveUp || busy}
          onClick={() => onMoveUp(log.id)}
          className="qsh-touch-target rounded-control px-2 text-xs text-slate-600 ring-1 ring-brand-100 transition duration-qsh-base ease-qsh-out enabled:hover:bg-brand-50 disabled:opacity-40 dark:text-slate-300 dark:ring-slate-700 dark:enabled:hover:bg-slate-700"
          aria-label={mealMoveUpAria(name)}
          data-testid={`meal-up-${log.id}`}
        >
          上移
        </button>
        <button
          type="button"
          disabled={!canMoveDown || busy}
          onClick={() => onMoveDown(log.id)}
          className="qsh-touch-target rounded-control px-2 text-xs text-slate-600 ring-1 ring-brand-100 transition duration-qsh-base ease-qsh-out enabled:hover:bg-brand-50 disabled:opacity-40 dark:text-slate-300 dark:ring-slate-700 dark:enabled:hover:bg-slate-700"
          aria-label={mealMoveDownAria(name)}
          data-testid={`meal-down-${log.id}`}
        >
          下移
        </button>
        <select
          value=""
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value as MealType | '';
            event.target.value = '';
            if (next !== '') {
              onMoveTo(log.id, next);
            }
          }}
          aria-label={mealMoveSelectAria(name)}
          data-testid={`meal-move-${log.id}`}
          className="qsh-touch-target rounded-control px-2 text-xs text-slate-600 ring-1 ring-brand-100 transition duration-qsh-base ease-qsh-out enabled:hover:bg-brand-50 disabled:opacity-40 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700 dark:enabled:hover:bg-slate-700"
        >
          <option value="">移动到…</option>
          {otherMeals.map((meal) => (
            <option key={meal.mealType} value={meal.mealType}>
              {meal.label}
            </option>
          ))}
        </select>
        {/*
          给读屏用户的等价「移动到某餐」按钮组（select 之外再给一组显式按钮，
          保证「把「番茄炒蛋」移动到午餐」这条可读语句确实存在于无障碍树）。

          ⚠️ `tabIndex={-1}` 是**必须的**：本组按钮视觉上不可见（`qsh-sr-only`），
          若留在 Tab 序列里，键盘用户会聚焦到一个看不见、也没有可见焦点圈的元素上
          （WCAG 2.4.7）。键盘路径由上面的 `<select>` 承担，读屏用户仍可用虚拟光标
          激活本组按钮 —— 两条路径功能等价，Tab 序列里只保留可见的那个。
        */}
        <span className="qsh-sr-only">
          {otherMeals.map((meal) => (
            <button
              key={meal.mealType}
              type="button"
              tabIndex={-1}
              disabled={busy}
              onClick={() => onMoveTo(log.id, meal.mealType)}
              aria-label={mealMoveToAria(name, meal.label)}
              data-testid={`meal-move-${meal.mealType}-${log.id}`}
            >
              {MEAL_TYPE_LABELS[meal.mealType]}
            </button>
          ))}
        </span>
      </div>
    </li>
  );
}
