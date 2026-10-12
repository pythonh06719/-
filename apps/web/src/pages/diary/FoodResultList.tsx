import type { ReactElement } from 'react';
import type { FoodItem, FoodSearchHit, UnitSystem } from '@qsh/shared-types';
import { foodCategoryLabel } from '@qsh/core';
import { COPY, favoriteToggleAria, foodHistoryToggleAria } from '@/lib/copy';
import { emojiForCategory } from '@/lib/food-emoji';
import { energyLabel, toDisplayEnergy } from '@/lib/units';
import FoodHistoryPanel from './FoodHistoryPanel';

/**
 * 食物结果列表（pages/diary/FoodResultList.tsx，2026-10-12 UI 评审 P1-4 抽出）。
 *
 * 从 `MealComposer` 的 `renderFoodList` 原样搬出 —— 搜索 / 分类 / 最近 / 收藏 /
 * 常吃五个面板共用同一份行渲染（「份量确认 → 确认记录」行为完全一致，不另写一套）。
 * **纯展示 + 回调**：本组件不持有任何状态，所有交互经 props 上报。
 *
 * 抽出的目的：MealComposer 曾是 1824 行的单函数组件，任何 UI 调整都要在巨型
 * 文件里定位；本块是其中最大的一块自包含 JSX（约 90 行）。份量确认区 / 待记
 * 清单 / 确认按钮依赖 20+ 个内部符号（state / query / mutation），props  drilling
 * 会比不拆更糟，经评估**留档不拆**，见 MealComposer 头部注释。
 *
 * ⚠️ 行内三个按钮（选食物 / 历史 / 星号）是**平级兄弟**，历史与星号各自
 * `stopPropagation` —— 绝不让附属点击冒泡去选中这一行。搬移时逐字保留。
 */

export interface FoodResultListProps {
  items: readonly FoodItem[];
  /** 已收藏食物 id 集合（来自 favoriteQuery 的投影） */
  favoriteIds: ReadonlySet<number>;
  /** 当前展开历史的食物 id（同一时刻只展开一个） */
  historyFoodId: number | null;
  /** 热量展示单位（kcal / kJ，仅展示换算） */
  unit: UnitSystem;
  onChoose: (food: FoodItem) => void;
  onToggleHistory: (foodId: number) => void;
  onToggleFavorite: (food: FoodItem) => void;
  favoritePending: boolean;
}

export default function FoodResultList({
  items,
  favoriteIds,
  historyFoodId,
  unit,
  onChoose,
  onToggleHistory,
  onToggleFavorite,
  favoritePending,
}: FoodResultListProps): ReactElement {
  return (
    <ul className="mt-block space-y-2">
      {items.map((food) => {
        const qualifier = 'qualifier' in food ? (food as FoodSearchHit).qualifier : null;
        const favorited = favoriteIds.has(food.id);
        const historyOpen = historyFoodId === food.id;
        return (
          <li
            key={food.id}
            className="rounded-control ring-1 ring-brand-100 transition duration-qsh-base ease-qsh-out hover:bg-brand-50 dark:ring-slate-700 dark:hover:bg-slate-700"
          >
            <div className="flex items-stretch gap-1">
              <button
                type="button"
                onClick={() => onChoose(food)}
                className="qsh-touch-target min-w-0 flex-1 rounded-l-xl px-4 py-3 text-left"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
                  <span aria-hidden="true" className="text-base">
                    {emojiForCategory(food.category)}
                  </span>
                  <span className="min-w-0 truncate">{food.name}</span>
                  {qualifier !== null && (
                    <span className="shrink-0 rounded-pill bg-slate-100 px-2 py-0.5 text-caption font-normal text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                      {qualifier}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-300">
                  {foodCategoryLabel(food.category)} · 每 100g {toDisplayEnergy(food.kcalPer100g, unit)} {energyLabel(unit)}
                </span>
              </button>
              {/*
                D-5 历史开关：与「选食物」「星号」**平级的第三个按钮**（不是嵌套）。
                视觉刻意做轻（次级动作），不与「选中这一行」抢主操作。
              */}
              <button
                type="button"
                aria-expanded={historyOpen}
                aria-controls={historyOpen ? `food-history-panel-${food.id}` : undefined}
                aria-label={foodHistoryToggleAria(food.name, historyOpen)}
                onClick={(event) => {
                  // 独立控件：绝不让这次点击冒泡去选中 / 记录这一行食物
                  event.stopPropagation();
                  onToggleHistory(food.id);
                }}
                aria-pressed={historyOpen}
                className="qsh-touch-target shrink-0 px-2 text-xs text-slate-500 dark:text-slate-400"
              >
                {COPY.foodHistoryToggle}
              </button>
              <button
                type="button"
                aria-pressed={favorited}
                aria-label={favoriteToggleAria(food.name, favorited)}
                disabled={favoritePending}
                onClick={(event) => {
                  // 星号是独立控件：绝不让这次点击冒泡去选中 / 记录这一行食物
                  event.stopPropagation();
                  onToggleFavorite(food);
                }}
                className="qsh-touch-target shrink-0 rounded-r-xl px-3 text-lg leading-none disabled:opacity-60"
              >
                <span
                  aria-hidden="true"
                  // ☆ 是**可点控件**的状态指示（不是装饰），WCAG 1.4.11 要 ≥3:1：
                  // 原来的 `text-slate-300` 对白底只有 1.48:1，等于看不见「还能收藏」这个入口。
                  // 深色档原来的 slate-500 对 slate-800 是 3.07:1，也仅勉强过线，一并提到
                  // slate-400（5.71:1）。★ 的 amber-400 是「已收藏」的既有语义，不动。
                  className={favorited ? 'text-amber-400' : 'text-slate-500 dark:text-slate-400'}
                >
                  {favorited ? '★' : '☆'}
                </span>
              </button>
            </div>
            {/* 展开区：`<li>` 的子节点，与上面的按钮们**平级**（不在任何按钮内部）。 */}
            {historyOpen && (
              <div id={`food-history-panel-${food.id}`} className="px-3 pb-3">
                <FoodHistoryPanel
                  food={food}
                  expanded={historyOpen}
                  onCollapse={() => onToggleHistory(food.id)}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
