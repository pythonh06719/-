import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { foodCategoryLabel } from '@qsh/core';
import type { FoodItem } from '@qsh/shared-types';
import { api, noticeFromError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { COPY, myFoodDeleteAria } from '@/lib/copy';
import { useUnitStore } from '@/lib/units';
import EmptyState from '@/components/common/EmptyState';
import EditFoodDialog from './EditFoodDialog';
import type { EditFoodSubmit } from './EditFoodDialog';

/**
 * 我的食物库（pages/foods/MyFoodsPage.tsx，C-4 第二步）。
 *
 * ## 为什么做这个页面
 *
 * C-4 第一步让「快加卡」记下的食物能**存进**食物库（`POST /foods`，
 * 服务端强制 `source='user_custom'` + `createdByUserId=本人`）。但**存了不能管**：
 * 把「红烧肉」打成「红烧内」存进库，错的那条永远留在库里，每次搜索都出现。
 * 本页补上「能管」：列出**本人自建**的食物，可改、可删。
 *
 * ## 数据来源
 *
 * `GET /api/foods/mine`：**只返回本人自建**（`source=user_custom` 且 `createdByUserId=本人`），
 * **不含** builtin / openfoodfacts / usda / cfcd 等公开来源 —— 这是「管理我存的东西」，
 * 不是「浏览全库」。返回 `FoodItem[]`（与 `GET /foods/recent` 同形态）。
 *
 * ## 缓存联动
 *
 * `queryKey` 用 `queryKeys.foodMine`（前缀 `['foods']`），改 / 删成功后
 * `invalidateQueries({ queryKey: ['foods'] })` 一并失效搜索 / 最近 / 常吃榜等，
 * 保证「删掉的错条目不再出现在任何地方」。
 *
 * ## 红线（PRD §7 无负罪感 / NFR-11）
 * - **不展示新数字**：只列名称、分类、每 100g 热量（与食物库其它位置同一口径），
 *   故本功能**不需要**动 `/why-numbers`；
 * - 删除 / 改的失败提示一律**中性过去式软着陆**（「已经删掉了」/「这条这次没有删掉，稍后再试试」），
 *   绝不出现「失败 / 错误 / 崩溃」，绝不用红色恐吓；
 * - 条目级删除**无二次确认**（全仓条目级删除惯例一致）。
 *
 * ## UI 规范自检（`docs/VISUAL-SYSTEM.md`）
 * - 触控：按钮一律 `qsh-touch-target`（≥44×44）；行内动作 `text-slate-600` 静止态、`hover:text-coral-600`；
 * - 圆角 / 动效：语义令牌 `rounded-control` / `duration-qsh-base` + `ease-qsh-out`；
 * - 对比度：12px（`text-xs`）文字统一 `slate-600` / `dark:slate-300`。
 */
export default function MyFoodsPage(): ReactElement {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<FoodItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  /** 全局热量单位（K6 / R2.11）：每 100g 热量按此换算 —— 与食物库其它位置同一展示口径。 */
  const unit = useUnitStore((state) => state.unit);

  const mineQuery = useQuery({
    queryKey: queryKeys.foodMine,
    queryFn: () => api.get<FoodItem[]>('/foods/mine'),
    retry: 0,
  });

  /** 失效所有食物相关查询（前缀 `['foods']`）—— 删除后错条目不应再出现在任何列表。 */
  const refreshFoods = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['foods'] });
  };

  const updateMutation = useMutation({
    mutationFn: async (payload: { id: number; body: EditFoodSubmit }): Promise<void> => {
      await api.patch<FoodItem>(`/foods/${payload.id}`, payload.body);
    },
    onSuccess: () => {
      setEditing(null);
      setEditError(null);
      setNotice(COPY.myFoodsEdited);
      refreshFoods();
    },
    onError: (error) => {
      // 服务端错误就地展示、弹窗不关闭、保留已填内容（用户改一个字就能重提交）。
      setEditError(noticeFromError(error, COPY.myFoodsEditMissed));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number): Promise<void> => {
      await api.delete<{ deleted: true }>(`/foods/${id}`);
    },
    onSuccess: () => {
      setNotice(COPY.myFoodsDeleted);
      refreshFoods();
    },
    onError: () => {
      setNotice(COPY.myFoodsDeleteMissed);
    },
  });

  const items = mineQuery.data ?? [];

  return (
    // 容器边距与其余 5 页对齐（`mx-auto max-w-xl px-4 pb-24 pt-4`）：本页此前完全依赖
    // AppShell 提供边距，是全站唯一一个左右留白与别页不一致的页面。
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pb-24 pt-4">
      <section
        aria-label={COPY.myFoodsTitle}
        className="qsh-surface p-5"
      >
        <h2 className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">{COPY.myFoodsTitle}</h2>
        <p className="mt-tight text-sm text-slate-600 dark:text-slate-300">{COPY.myFoodsDesc}</p>
      </section>

      {notice !== null && (
        <p
          role="status"
          data-testid="my-foods-notice"
          className="rounded-control bg-brand-50 px-3 py-2 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
        >
          {notice}
        </p>
      )}

      <section aria-label="我存过的食物" className="qsh-surface p-5">
        {mineQuery.isLoading ? (
          /* 骨架而非灰字：此前「还在拿」与「拿不到」是同一行灰字，用户分不清。
             骨架块用 `h-12` + `rounded-control`，与下方真实列表项（`:132`）同几何，
             数据到位那一刻不形变。文案对读屏仍有价值，用 `qsh-sr-only` 保留。 */
          <div className="min-h-[72px]" role="status" aria-live="polite">
            <span className="qsh-sr-only">{COPY.myFoodsLoading}</span>
            <div className="h-12 w-full animate-pulse rounded-control bg-slate-100 dark:bg-slate-700" />
            <div className="mt-2 h-12 w-full animate-pulse rounded-control bg-slate-100 dark:bg-slate-700" />
          </div>
        ) : mineQuery.isError ? (
          <p role="status" className="text-body text-slate-600 dark:text-slate-300">
            {COPY.myFoodsLoadError}
          </p>
        ) : items.length === 0 ? (
          /* `EmptyState` 自带 `p-5`，外层 section 已是 `p-5` → 用任意值选择器收进内容区，
             避免双层内边距；`data-testid` 按契约必须保留，故挂在 title 元素上。 */
          <div className="[&_.qsh-surface-warm]:p-4">
            <EmptyState title={<span data-testid="my-foods-empty">{COPY.myFoodsEmpty}</span>} />
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((food) => (
              <li
                key={food.id}
                data-testid={`my-food-item-${food.id}`}
                className="flex items-center justify-between gap-3 rounded-control px-3 py-2 ring-1 ring-brand-100 dark:ring-slate-700"
              >
                <div className="min-w-0">
                  {/* 自建食物名是用户任意长的输入，单行省略后桌面端靠 title 恢复全名
                      （读屏不受影响：截断是纯视觉，DOM 文本始终完整）。约定见 VISUAL-SYSTEM.md §5。 */}
                  <p className="truncate text-sm text-slate-800 dark:text-slate-100" title={food.name}>
                    {food.name}
                  </p>
                  <p className="qsh-tnum truncate text-xs text-slate-600 dark:text-slate-300">
                    {foodCategoryLabel(food.category)} · {COPY.myFoodsKcalPer100g(food.kcalPer100g, unit)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setEditError(null);
                      setEditing(food);
                    }}
                    data-testid={`my-food-edit-${food.id}`}
                    className="qsh-touch-target rounded-control px-2 text-caption text-slate-600 transition-colors duration-qsh-base ease-qsh-out hover:text-coral-600 dark:text-slate-300"
                    aria-label={`${COPY.myFoodsEdit}：${food.name}`}
                  >
                    {COPY.myFoodsEdit}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteMutation.mutate(food.id)}
                    disabled={deleteMutation.isPending && deleteMutation.variables === food.id}
                    data-testid={`my-food-delete-${food.id}`}
                    className="qsh-touch-target shrink-0 rounded-control px-2 text-caption text-slate-600 transition-colors duration-qsh-base ease-qsh-out hover:text-coral-600 disabled:opacity-40 dark:text-slate-300"
                    aria-label={myFoodDeleteAria(food.name)}
                  >
                    {COPY.myFoodsDelete}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing !== null && (
        <EditFoodDialog
          food={editing}
          busy={updateMutation.isPending}
          errorText={editError}
          onCancel={() => {
            setEditing(null);
            setEditError(null);
          }}
          onSubmit={(payload) => updateMutation.mutate({ id: editing.id, body: payload })}
        />
      )}
    </div>
  );
}
