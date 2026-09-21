import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateMealLogRequest,
  ListMealsResponse,
  MealGroup,
  MealLog,
} from '@qsh/shared-types';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { CACHE_KEYS, cacheGet, cacheSet } from '@/lib/local-cache';
import { addDays, formatDateLabel, todayKey } from '@/lib/format';
import { energyLabel, toDisplayEnergy, useUnitStore } from '@/lib/units';
import { COPY } from '@/lib/copy';
import { emojiForFoodName } from '@/lib/food-emoji';
import EmptyState from '@/components/common/EmptyState';
import { MEAL_BUDGET_SHARE, type ThemeBudget } from '@/theme/tokens';
import MealComposer from './MealComposer';
import type { ComposerSubmit } from './MealComposer';
import { MEAL_TYPE_LABELS, MEAL_TYPE_ORDER, computeKcalFromFood, sumKcal } from './meal-utils';
import { enqueueRequest } from '@/pwa/offline-queue';

/**
 * 饮食日记（`/diary`，PRD §6 第 4 行 / R3.8 / R3.10 / TC-25~TC-27）。
 *
 * - 日历式日期切换（前一天 / 今天 / 后一天）
 * - 按餐分组（早/午/晚/加餐），每餐展示独立参考预算
 * - **≤3 次点击完成记录**（打开面板 → 选食物 → 确认）
 * - 记录后**即时反馈**：本餐热量 + 今日进度（`aria-live` 播报，TC-48）
 * - 支持删除条目；离线时进离线队列并本地乐观更新（TC-47 / Q7）
 */

interface DiaryPageProps {
  /** 允许外部注入初始日期（测试用） */
  initialDate?: string;
}

/** 每餐参考预算 = 每日预算 × 餐次占比。 */
function mealBudget(dailyBudget: number, mealType: keyof typeof MEAL_BUDGET_SHARE): number {
  const share = MEAL_BUDGET_SHARE[mealType];
  return Math.round(dailyBudget * share);
}

/** 从缓存读取每日预算（引导结果 / 看板）作为每餐预算的分母。 */
function readDailyBudget(): number {
  const budget = cacheGet<ThemeBudget>(CACHE_KEYS.localBudget);
  return budget === null || !Number.isFinite(budget.intakeRecommended) ? 0 : budget.intakeRecommended;
}

/** 把接口返回的 groups 归一为「四个餐次都有」的结构。 */
function normalizeGroups(response: ListMealsResponse | undefined): MealGroup[] {
  const byType = new Map<string, MealLog[]>();
  for (const group of response?.groups ?? []) {
    byType.set(group.mealType, group.logs ?? []);
  }
  return MEAL_TYPE_ORDER.map((mealType) => {
    const logs = byType.get(mealType) ?? [];
    return { mealType, logs, totalKcal: sumKcal(logs) };
  });
}

export default function DiaryPage({ initialDate }: DiaryPageProps): ReactElement {
  const unit = useUnitStore((state) => state.unit);
  const queryClient = useQueryClient();
  const [date, setDate] = useState<string>(() => initialDate ?? todayKey());
  const [composerMeal, setComposerMeal] = useState<MealGroup['mealType'] | null>(null);
  const [announcement, setAnnouncement] = useState<string>('');
  const [notice, setNotice] = useState<string | null>(null);

  const mealsQuery = useQuery({
    queryKey: queryKeys.meals(date),
    queryFn: () => api.get<ListMealsResponse>('/meals', { date }),
  });

  useEffect(() => {
    if (mealsQuery.data !== undefined) {
      cacheSet(CACHE_KEYS.meals(date), mealsQuery.data);
    }
  }, [mealsQuery.data, date]);

  const groups = useMemo(
    () => normalizeGroups(mealsQuery.data ?? cacheGet<ListMealsResponse>(CACHE_KEYS.meals(date)) ?? undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mealsQuery.data, date],
  );

  const dailyBudget = useMemo(() => readDailyBudget(), []);
  const todayTotal = useMemo(
    () => groups.reduce((total, group) => total + group.totalKcal, 0),
    [groups],
  );

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.meals(date) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(date) });
  };

  const remove = useMutation({
    mutationFn: (id: number) => api.delete<{ id: number }>(`/meals/${id}`),
    onSuccess: async () => {
      setAnnouncement('已删除这条记录');
      await invalidate();
    },
    onError: () => setNotice('暂时没能删除这条记录，稍后再试一次就好'),
  });

  /** 记录成功后：本地乐观更新缓存 + 播报（离线时也立即反馈）。 */
  const applyOptimistic = (mealType: MealGroup['mealType'], log: MealLog): void => {
    const cached = cacheGet<ListMealsResponse>(CACHE_KEYS.meals(date)) ?? { groups: [], totalKcal: 0 };
    const nextGroups = MEAL_TYPE_ORDER.map((type) => {
      const existing = cached.groups.find((group) => group.mealType === type);
      const logs = existing?.logs ?? [];
      if (type !== mealType) {
        return { mealType: type, logs, totalKcal: sumKcal(logs) };
      }
      const nextLogs = [...logs, log];
      return { mealType: type, logs: nextLogs, totalKcal: sumKcal(nextLogs) };
    });
    const next: ListMealsResponse = {
      date,
      groups: nextGroups,
      totalKcal: nextGroups.reduce((total, group) => total + group.totalKcal, 0),
    };
    cacheSet(CACHE_KEYS.meals(date), next);
    queryClient.setQueryData(queryKeys.meals(date), next);
  };

  const handleSubmit = async (payload: ComposerSubmit): Promise<void> => {
    if (composerMeal === null) {
      return;
    }
    const mealType = composerMeal;
    let kcal = 0;
    let request: CreateMealLogRequest;

    if (payload.kind === 'food') {
      kcal = computeKcalFromFood(payload.food, payload.grams);
      request = {
        loggedDate: date,
        mealType,
        source: payload.source ?? 'search',
        foodId: payload.food.id,
        grams: payload.grams,
        servingUnit: payload.servingUnit,
      };
    } else if (payload.kind === 'quick') {
      kcal = payload.kcal;
      request = {
        loggedDate: date,
        mealType,
        source: 'quick_add',
        customName: payload.name,
        customKcal: payload.kcal,
      };
    } else {
      // 套餐一键添加：走专用接口
      try {
        await api.post(`/meal-combos/${payload.comboId}/apply`, { loggedDate: date, mealType });
        setComposerMeal(null);
        setAnnouncement(`${MEAL_TYPE_LABELS[mealType]}已按套餐记录`);
        await invalidate();
        return;
      } catch {
        await enqueueRequest({
          path: `/meal-combos/${payload.comboId}/apply`,
          method: 'POST',
          body: { loggedDate: date, mealType },
        });
        setComposerMeal(null);
        setNotice(COPY.offlineQueued);
        setAnnouncement(COPY.mealLoggedAnnounce);
        return;
      }
    }

    try {
      await api.post<MealLog>('/meals', request);
      setComposerMeal(null);
      setNotice(null);
      setAnnouncement(`${MEAL_TYPE_LABELS[mealType]}已记录，约 ${kcal} kcal`);
      await invalidate();
    } catch {
      // 离线：入队 + 本地乐观更新，界面立即反馈（不阻塞用户）
      await enqueueRequest({
        path: '/meals',
        method: 'POST',
        body: request,
      });
      applyOptimistic(mealType, {
        id: Date.now(),
        userId: 0,
        loggedDate: date,
        mealType,
        foodItemId: payload.kind === 'food' ? payload.food.id : null,
        customName: payload.kind === 'quick' ? payload.name : null,
        grams: payload.kind === 'food' ? payload.grams : null,
        servingUnit: payload.kind === 'food' ? payload.servingUnit : null,
        servingQty: null,
        kcal,
        proteinG: null,
        fatG: null,
        carbG: null,
        fiberG: null,
        sodiumMg: null,
        source: payload.kind === 'quick' ? 'quick_add' : (payload.source ?? 'search'),
        comboId: null,
        note: null,
        sortOrder: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      setComposerMeal(null);
      setNotice(COPY.offlineQueued);
      setAnnouncement(`${MEAL_TYPE_LABELS[mealType]}已记录，约 ${kcal} kcal`);
    }
  };

  const progressRatio = dailyBudget > 0 ? todayTotal / dailyBudget : 0;

  /** 整日都没有记录时，给一个生活化的空状态（大 emoji + 一句话）。 */
  const isEmptyDay = groups.every((group) => group.logs.length === 0);

  return (
    <section aria-labelledby="diary-title" className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 id="diary-title" className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          饮食记录
        </h1>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setDate((current) => addDays(current, -1))}
            className="qsh-touch-target rounded-lg px-3 text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
            aria-label="前一天"
          >
            ‹
          </button>
          <span className="px-2 text-sm text-slate-600 dark:text-slate-300">{formatDateLabel(date)}</span>
          <button
            type="button"
            onClick={() => setDate((current) => addDays(current, 1))}
            className="qsh-touch-target rounded-lg px-3 text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
            aria-label="后一天"
          >
            ›
          </button>
        </div>
      </div>

      <div className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700">
        <p className="text-sm text-slate-500 dark:text-slate-400">今天一共</p>
        <p className="qsh-tnum mt-1 text-3xl font-bold text-brand-700 dark:text-brand-300">
          {toDisplayEnergy(todayTotal, unit)}
          <span className="ml-1.5 text-sm font-medium text-slate-500 dark:text-slate-400">
            {energyLabel(unit)}
          </span>
        </p>
        {dailyBudget > 0 && (
          <div className="mt-3">
            <div className="h-2 w-full overflow-hidden rounded-full bg-brand-100 dark:bg-slate-700">
              <div
                className="h-full rounded-full bg-brand-500 transition-all"
                style={{ width: `${Math.min(progressRatio, 1) * 100}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              参考预算 {toDisplayEnergy(dailyBudget, unit)} {energyLabel(unit)}
              {progressRatio > 1 ? ' · 今天吃得丰富一些，明天照常就好' : ''}
            </p>
          </div>
        )}
      </div>

      {/* 空状态（共用组件第一处接入）：品牌花替代原先的 emoji 插画位，
          文案保持原样不动（语气规范由 copy.ts 统一把关） */}
      {isEmptyDay && <EmptyState title={COPY.emptyTodayDiary} />}

      {/* 屏幕阅读器播报记录结果（TC-48） */}
      <p className="qsh-sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {notice !== null && (
        <p role="status" className="rounded-xl bg-brand-50 px-4 py-2 text-sm text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          {notice}
        </p>
      )}

      {groups.map((group) => {
        const budget = dailyBudget > 0 ? mealBudget(dailyBudget, group.mealType) : 0;
        return (
          <section
            key={group.mealType}
            aria-label={MEAL_TYPE_LABELS[group.mealType]}
            className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {MEAL_TYPE_LABELS[group.mealType]}
              </h2>
              <p className="qsh-tnum text-xs text-slate-500 dark:text-slate-400">
                {toDisplayEnergy(group.totalKcal, unit)}
                {budget > 0 ? ` / 参考 ${toDisplayEnergy(budget, unit)}` : ''} {energyLabel(unit)}
              </p>
            </div>

            {group.logs.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                <span aria-hidden="true" className="mr-1">
                  🍽️
                </span>
                还没有记录，点一下下面就好
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {group.logs.map((log) => (
                  <li
                    key={log.id}
                    className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 ring-1 ring-brand-100 dark:ring-slate-700"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span aria-hidden="true" className="text-lg">
                        {emojiForFoodName(log.customName)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm text-slate-800 dark:text-slate-100">
                          {log.customName ?? `食物 #${log.foodItemId ?? '—'}`}
                        </p>
                        <p className="qsh-tnum text-xs text-slate-500 dark:text-slate-400">
                          {toDisplayEnergy(log.kcal, unit)} {energyLabel(unit)}
                          {log.grams !== null ? ` · ${log.grams}g` : ''}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (typeof log.id === 'number' && log.id > 0) {
                          remove.mutate(log.id);
                        }
                      }}
                      className="qsh-touch-target shrink-0 rounded-lg px-3 text-xs text-slate-500 hover:text-coral-600 dark:text-slate-400"
                      aria-label={`删除 ${log.customName ?? '这条记录'}`}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={() => setComposerMeal(group.mealType)}
              className="qsh-touch-target mt-3 w-full rounded-xl bg-brand-50 py-2.5 text-sm font-medium text-brand-700 transition hover:bg-brand-100 dark:bg-brand-900/40 dark:text-brand-200"
            >
              + 记录{MEAL_TYPE_LABELS[group.mealType]}
            </button>
          </section>
        );
      })}

      {composerMeal !== null && (
        <MealComposer
          date={date}
          mealType={composerMeal}
          onClose={() => setComposerMeal(null)}
          onSubmit={handleSubmit}
        />
      )}
    </section>
  );
}
