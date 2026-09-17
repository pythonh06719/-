import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FoodItem, MealComboWithItems, MealType, SearchFoodsResponse } from '@qsh/shared-types';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { COPY } from '@/lib/copy';
import { emojiForCategory } from '@/lib/food-emoji';
import { energyLabel, toDisplayEnergy, useUnitStore } from '@/lib/units';
import { MEAL_TYPE_LABELS, computeKcalFromFood, resolveDefaultServing } from './meal-utils';

/**
 * 记录一餐面板（pages/diary/MealComposer.tsx）—— 四种记录方式（R3.4/R3.5/R3.8/R3.9）。
 *
 * **★ 3 次点击完成记录（TC-25）**：打开面板（1）→ 选食物（2）→ 点「确认记录」（3）。
 * 最近 / 收藏 / 套餐均为「一次点击直接确认」，更快。
 *
 * 搜索 / 最近 / 收藏 / 套餐接口未成功时退化为空列表并给出温和提示，不阻塞快速加卡（离线可用）。
 */

export type ComposerSubmit =
  | { kind: 'food'; food: FoodItem; grams: number; servingUnit: string }
  | { kind: 'quick'; name: string; kcal: number }
  | { kind: 'combo'; comboId: number };

export interface MealComposerProps {
  /** 记录日期（`YYYY-MM-DD`） */
  date: string;
  /** 餐次 */
  mealType: MealType;
  /** 关闭面板 */
  onClose: () => void;
  /** 提交（由父组件负责入库 / 离线队列 / 反馈） */
  onSubmit: (payload: ComposerSubmit) => Promise<void>;
}

type TabKey = 'search' | 'recent' | 'favorite' | 'quick' | 'combo';

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'search', label: '搜索' },
  { key: 'recent', label: '最近' },
  { key: 'favorite', label: '收藏' },
  { key: 'quick', label: '快加' },
  { key: 'combo', label: '套餐' },
];

export default function MealComposer({
  date,
  mealType,
  onClose,
  onSubmit,
}: MealComposerProps): ReactElement {
  const unit = useUnitStore((state) => state.unit);
  const [tab, setTab] = useState<TabKey>('search');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<FoodItem | null>(null);
  const [grams, setGrams] = useState('100');
  const [servingUnit, setServingUnit] = useState('克');
  const [quickName, setQuickName] = useState('');
  const [quickKcal, setQuickKcal] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const searchQuery = useQuery({
    queryKey: queryKeys.foodSearch(keyword, ''),
    queryFn: () => api.get<SearchFoodsResponse>('/foods', { q: keyword, limit: 20, offset: 0 }),
    enabled: tab === 'search' && keyword.trim() !== '',
  });

  const recentQuery = useQuery({
    queryKey: queryKeys.foodRecent,
    queryFn: () => api.get<FoodItem[]>('/foods/recent'),
    enabled: tab === 'recent',
  });

  const favoriteQuery = useQuery({
    queryKey: queryKeys.foodFavorites,
    queryFn: () => api.get<FoodItem[]>('/foods/favorites'),
    enabled: tab === 'favorite',
  });

  const comboQuery = useQuery({
    queryKey: queryKeys.combos,
    queryFn: () => api.get<MealComboWithItems[]>('/meal-combos'),
    enabled: tab === 'combo',
  });

  useEffect(() => {
    if (searchQuery.isError || recentQuery.isError || favoriteQuery.isError || comboQuery.isError) {
      setNote('这部分内容暂时取不到，先用「快加」也能记下这一餐');
    }
  }, [searchQuery.isError, recentQuery.isError, favoriteQuery.isError, comboQuery.isError]);

  const chooseFood = (food: FoodItem): void => {
    const serving = resolveDefaultServing(food);
    setSelected(food);
    setServingUnit(serving.unit);
    setGrams(String(serving.grams));
  };

  const gramsNumber = Number(grams);
  const previewKcal = selected === null ? 0 : computeKcalFromFood(selected, gramsNumber);

  const run = async (payload: ComposerSubmit): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await onSubmit(payload);
    } finally {
      setBusy(false);
    }
  };

  const renderFoodList = (items: readonly FoodItem[]): ReactElement => (
    <ul className="mt-3 space-y-2">
      {items.map((food) => (
        <li key={food.id}>
          <button
            type="button"
            onClick={() => chooseFood(food)}
            className="qsh-touch-target w-full rounded-xl px-4 py-3 text-left ring-1 ring-brand-100 transition hover:bg-brand-50 dark:ring-slate-700 dark:hover:bg-slate-700"
          >
            <span className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
              <span aria-hidden="true" className="text-base">
                {emojiForCategory(food.category)}
              </span>
              {food.name}
            </span>
            <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-300">
              {food.category} · 每 100g {food.kcalPer100g} kcal
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`记录${MEAL_TYPE_LABELS[mealType]}`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4"
    >
      <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl dark:bg-slate-800 sm:rounded-3xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            记录{MEAL_TYPE_LABELS[mealType]}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="qsh-touch-target rounded-lg px-3 text-sm text-slate-500 dark:text-slate-400"
            aria-label="关闭记录面板"
          >
            关闭
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{date}</p>

        {/* 记录方式标签 */}
        <div role="tablist" aria-label="记录方式" className="mt-4 flex gap-1.5 overflow-x-auto">
          {TABS.map((item) => (
            <button
              key={item.key}
              role="tab"
              type="button"
              aria-selected={tab === item.key}
              onClick={() => {
                setTab(item.key);
                setSelected(null);
              }}
              className={[
                'qsh-touch-target shrink-0 rounded-full px-4 text-sm transition',
                tab === item.key
                  ? 'bg-brand-600 text-white'
                  : 'bg-brand-50 text-slate-600 dark:bg-slate-900 dark:text-slate-300',
              ].join(' ')}
            >
              {item.label}
            </button>
          ))}
        </div>

        {note !== null && (
          <p role="status" className="mt-3 rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
            {note}
          </p>
        )}

        {/* 搜索 */}
        {tab === 'search' && (
          <div className="mt-4">
            <label className="block text-sm text-slate-600 dark:text-slate-300">
              搜索食物
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="如：番茄、米饭、拿铁"
                className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            {searchQuery.isFetching && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">搜索中…</p>}
            {searchQuery.data !== undefined && renderFoodList(searchQuery.data.items)}
            {keyword.trim() !== '' &&
              searchQuery.data !== undefined &&
              searchQuery.data.items.length === 0 &&
              !searchQuery.isFetching && (
                <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                  没有找到这条食物，试试「快加」
                </p>
              )}
          </div>
        )}

        {/* 最近 / 收藏 */}
        {(tab === 'recent' || tab === 'favorite') && (
          <div className="mt-4">
            {(() => {
              const query = tab === 'recent' ? recentQuery : favoriteQuery;
              if (query.isLoading) {
                return <p className="text-xs text-slate-500 dark:text-slate-400">读取中…</p>;
              }
              const items = query.data ?? [];
              if (items.length === 0) {
                return (
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {tab === 'recent' ? '还没有记录过食物' : '还没有收藏的食物'}
                  </p>
                );
              }
              return renderFoodList(items);
            })()}
          </div>
        )}

        {/* 快速加卡：仅名称 + 热量（R3.5 / TC-19） */}
        {tab === 'quick' && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm text-slate-600 dark:text-slate-300">
              名称
              <input
                value={quickName}
                onChange={(event) => setQuickName(event.target.value)}
                placeholder="如：楼下麻辣烫"
                className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block text-sm text-slate-600 dark:text-slate-300">
              热量（{energyLabel(unit)}）
              <input
                inputMode="numeric"
                value={quickKcal}
                onChange={(event) => setQuickKcal(event.target.value)}
                placeholder="如：600"
                className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <p className="text-xs text-slate-500 dark:text-slate-400">{COPY.quickAddHint}</p>
          </div>
        )}

        {/* 套餐模板（R3.9 / TC-26） */}
        {tab === 'combo' && (
          <div className="mt-4">
            {comboQuery.isLoading && <p className="text-xs text-slate-500 dark:text-slate-400">读取中…</p>}
            {(comboQuery.data ?? []).length === 0 && !comboQuery.isLoading && (
              <p className="text-sm text-slate-500 dark:text-slate-400">还没有保存的套餐模板</p>
            )}
            <ul className="space-y-2">
              {(comboQuery.data ?? []).map((combo) => (
                <li key={combo.id} className="flex items-center justify-between gap-3 rounded-xl px-4 py-3 ring-1 ring-brand-100 dark:ring-slate-700">
                  <span className="text-sm text-slate-800 dark:text-slate-100">{combo.name}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run({ kind: 'combo', comboId: combo.id })}
                    className="qsh-touch-target rounded-lg bg-brand-100 px-3 text-sm font-medium text-brand-700 disabled:opacity-60 dark:bg-brand-900 dark:text-brand-200"
                  >
                    一键添加
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 份量确认（第 3 次点击在这里） */}
        {selected !== null && (
          <section
            aria-label="选择份量"
            className="mt-5 rounded-2xl bg-brand-50 p-4 dark:bg-slate-900"
          >
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{selected.name}</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {(selected.servingUnits ?? []).map((item) => (
                <button
                  key={`${item.unit}-${item.grams}`}
                  type="button"
                  aria-pressed={servingUnit === item.unit}
                  onClick={() => {
                    setServingUnit(item.unit);
                    setGrams(String(item.grams));
                  }}
                  className={[
                    'qsh-touch-target rounded-full px-3 text-sm transition',
                    servingUnit === item.unit
                      ? 'bg-brand-600 text-white'
                      : 'bg-white text-slate-600 dark:bg-slate-800 dark:text-slate-300',
                  ].join(' ')}
                >
                  {item.label ?? `1 ${item.unit}`}（{item.grams}g）
                </button>
              ))}
            </div>
            <label className="mt-3 block text-sm text-slate-600 dark:text-slate-300">
              克数
              <input
                inputMode="decimal"
                value={grams}
                onChange={(event) => setGrams(event.target.value)}
                className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <p className="qsh-tnum mt-2 text-sm text-brand-700 dark:text-brand-200" aria-live="polite">
              预估 {toDisplayEnergy(previewKcal, unit)} {energyLabel(unit)}
            </p>
          </section>
        )}

        {/* 确认按钮 */}
        <div className="mt-5 flex gap-2">
          {tab === 'quick' || selected !== null ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (tab === 'quick') {
                  const kcalValue = Number(quickKcal);
                  if (quickName.trim() === '' || !Number.isFinite(kcalValue) || kcalValue <= 0) {
                    setNote('填一下名称和热量就能记下啦');
                    return;
                  }
                  void run({ kind: 'quick', name: quickName.trim(), kcal: kcalValue });
                  return;
                }
                if (selected === null) {
                  return;
                }
                const gramsValue = Number(grams);
                if (!Number.isFinite(gramsValue) || gramsValue <= 0) {
                  setNote('克数填一个大于 0 的数字就好');
                  return;
                }
                void run({ kind: 'food', food: selected, grams: gramsValue, servingUnit });
              }}
              className="qsh-touch-target flex-1 rounded-xl bg-brand-600 py-3 font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
            >
              {busy ? '正在记录…' : '确认记录'}
            </button>
          ) : (
            <p className="flex-1 text-center text-xs text-slate-500 dark:text-slate-400">
              先选一个食物，或者切到「快加」
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
