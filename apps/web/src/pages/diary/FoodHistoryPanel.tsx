import { useQuery } from '@tanstack/react-query';

import type { FoodHistoryResponse, MealType } from '@qsh/shared-types';
import { api } from '@/lib/api';
import {
  COPY,
  foodHistoryCloseAria,
  foodHistoryEntryAria,
  foodHistoryPortionText,
  foodHistoryTitle,
} from '@/lib/copy';
import { formatMonthDay, isDateKey } from '@/lib/format';
import { queryKeys } from '@/lib/queryClient';
import { MEAL_TYPE_LABELS } from './meal-utils';

/**
 * 食物食用历史（D-5）—— 「我什么时候吃过它」的**只读**明细列表。
 *
 * ## 落点：为什么挂在「食物被选中的地方」而不是常吃榜
 *
 * 用户真正会问「上次吃这道菜是什么时候」的时刻，发生在**搜索结果 / 最近 / 收藏**里 ——
 * 他正盯着某一行食物，还没决定记不记。常吃榜只在「窗口内 ≥ 3 天」时出现、且只列前 12 条，
 * 覆盖不到这些时刻。故本组件作为**次级动作**挂在食物行上（见 `MealComposer` 的
 * `renderFoodList`），三个 tab 共用同一处实现，一处接线覆盖全部场景。
 *
 * ## 🔴 只读：这里**不产生任何写入**
 *
 * 列表里**没有一个按钮**（除了父级那个「收起」）。它纯粹是「把已有的记录摆出来看」——
 * 一旦允许从这里直接写入，它就变成了另一个功能（且会绕过份量确认，热量必然失真）。
 *
 * ## 🔴 零汇总（QD-6）
 *
 * 本组件**从不**读 `items.length` 去渲染任何「共 N 天 / N 次」。`FoodHistoryResponse`
 * 契约里也没有「总数」字段 —— 不是「我们不显示」，是**数据里根本没有这个数**。
 *
 * ## 🔴 零健康暗示 / 零营养（AC-11.5.3 / AC-11.5.4）
 *
 * 渲染的三个字段是**日期 / 餐次 / 份量**。份量是「用户当时记下的量」，属既有事实，
 * 不是我们的营养判断 —— 故此处的类名一律 `slate` 中性色，**不出现** `red` / `amber` /
 * `yellow` / `orange`，也**不引入** `role="meter"`。
 *
 * ## 排序
 *
 * 顺序**完全由服务端给定**（`loggedDate` 降序）。本组件**不重排** —— 客户端再排一次
 * 就多了一个可能与服务端不一致的口径（NFR-11）。
 */

/** 组件入参。 */
export interface FoodHistoryPanelProps {
  /** 被查询的食物（历史以它的 `id` 为准；`name` 只用于标题文案） */
  food: { id: number; name: string };
  /** 展开态（收起时父级不渲染本组件，这里再判一次只为防御误用） */
  expanded: boolean;
  /** 收起回调（由父级把该行折回去） */
  onCollapse: () => void;
}

/** 展示条数上限：与服务端默认 `FOOD_HISTORY_DEFAULTS.limit` 对齐。 */
const HISTORY_LIMIT = 30;

/** 一行日期的格式化：非法日期键 → 空串（整段不渲染，不猜、不写「未知」）。 */
function historyDateLabel(dateKey: string | undefined): string {
  if (typeof dateKey !== 'string' || !isDateKey(dateKey)) {
    return '';
  }
  return formatMonthDay(dateKey);
}

/** 餐次码 → 中文名；未知码 → 空串（整段不渲染，不把脏值当餐次名展示）。 */
function historyMealLabel(mealType: string): string {
  return MEAL_TYPE_LABELS[mealType as MealType] ?? '';
}

export default function FoodHistoryPanel({ food, expanded, onCollapse }: FoodHistoryPanelProps): React.JSX.Element {
  // 🔴 只在展开时才发请求：折叠状态下不产生任何网络开销，也不预先拉一堆用不上的历史。
  // `queryKey` 按食物 id 分键，故展开 A 再展开 B 不会串数据（A 的缓存仍在，切回去即命中）。
  const historyQuery = useQuery({
    queryKey: queryKeys.foodHistory(food.id),
    queryFn: () =>
      api.get<FoodHistoryResponse>(`/foods/${food.id}/history`, { limit: HISTORY_LIMIT }),
    enabled: expanded,
  });

  // 防御：接口降级 / 契约不符时 `items` 可能不是数组 —— 当作「暂时没有」的空态，
  // 绝不把非数组喂给 `.map`（那会让整个记录面板崩掉）。
  const items = Array.isArray(historyQuery.data?.items) ? historyQuery.data.items : [];

  return (
    <div
      data-testid={`food-history-${food.id}`}
      className="mt-2 rounded-control bg-slate-50 p-3 dark:bg-slate-900/60"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700 dark:text-slate-200">
          {foodHistoryTitle(food.name)}
        </p>
        {/* 收起按钮：整块面板里**唯一**的可点元素，且它只改「看不看」，不写任何数据。
            ⚠️ aria-label 与行内那个开关**刻意不同句**（`关掉…` vs `收起…`）：
            展开后两者若同名，读屏会念出两个一样的名字、用户分不清按哪个。 */}
        <button
          type="button"
          onClick={onCollapse}
          aria-label={foodHistoryCloseAria(food.name)}
          className="qsh-touch-target shrink-0 rounded-control px-2 text-xs text-slate-600 dark:text-slate-400"
        >
          {COPY.foodHistoryCollapse}
        </button>
      </div>

      {historyQuery.isLoading ? (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">{COPY.foodHistoryLoading}</p>
      ) : historyQuery.isError ? (
        // 软着陆：只说「这次没读到」，不写「加载失败」，也不暗示「没有历史」
        // （没读到 ≠ 没有记录 —— §「不把缺失说成亏欠」）。
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">{COPY.foodHistoryError}</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">{COPY.foodHistoryEmpty}</p>
      ) : (
        <>
          <ul className="mt-2 space-y-1">
            {items.map((entry, index) => {
              const dateLabel = historyDateLabel(entry.loggedDate);
              if (dateLabel === '') {
                // 脏日期：整条不渲染（既不猜一个日期，也不显示原始串）。
                // 用 `index` 兜底 key —— 这里的数组是只读展示，不会重排。
                return null;
              }
              const mealLabel = historyMealLabel(entry.mealType);
              const portionText = foodHistoryPortionText(entry.grams, entry.servingUnit, entry.servingQty);
              return (
                <li
                  // 同一天可能有多条（不同餐次），故 key 必须含 index 才不撞
                  key={`${entry.loggedDate}-${entry.mealType}-${index}`}
                  aria-label={foodHistoryEntryAria(dateLabel, mealLabel, portionText)}
                  className="flex items-baseline gap-2 text-xs text-slate-600 dark:text-slate-300"
                >
                  <span className="qsh-tnum shrink-0">{dateLabel}</span>
                  {mealLabel !== '' && <span className="shrink-0">{mealLabel}</span>}
                  {/* 份量整段可选：快加卡没记份量时**不显示任何占位**（不写「0 克」）。 */}
                  {portionText !== '' && (
                    <span className="qsh-tnum min-w-0 truncate text-slate-500 dark:text-slate-400">
                      {portionText}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">{COPY.foodHistoryFootnote}</p>
        </>
      )}
    </div>
  );
}
