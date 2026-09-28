import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  FOOD_SEARCH_DEFAULT_PAGE_SIZE,
  FREQUENT_FOOD_DEFAULTS,
  findSameNameFood,
} from '@qsh/core';
import type {
  BarcodeLookupResponse,
  ExternalFoodItem,
  FoodItem,
  FoodSearchHit,
  FoodSearchResponse,
  LiveSearchResponse,
  MealComboWithItems,
  MealType,
  TopFoodItem,
  TopFoodsResponse,
} from '@qsh/shared-types';
import { ApiClientError, api } from '@/lib/api';
import BarcodeScanner from '@/components/common/BarcodeScanner';
import { queryKeys } from '@/lib/queryClient';
import { COPY, topFoodDaysLabel, topFoodsAria } from '@/lib/copy';
import { emojiForCategory } from '@/lib/food-emoji';
import { energyLabel, toDisplayEnergy, useUnitStore } from '@/lib/units';
import BrandDecor from '@/components/common/BrandDecor';
import { MEAL_TYPE_LABELS, computeKcalFromFood, resolveDefaultServing } from './meal-utils';

/**
 * 记录一餐面板（pages/diary/MealComposer.tsx）—— 四种记录方式（R3.4/R3.5/R3.8/R3.9）
 * + 在线食物库兜底 + 条码扫码（Phase C-1 / C-2）。
 *
 * **★ 3 次点击完成记录（TC-25）**：打开面板（1）→ 选食物（2）→ 点「确认记录」（3）。
 * 最近 / 收藏 / 套餐均为「一次点击直接确认」，更快。
 *
 * 搜索 / 最近 / 收藏 / 套餐接口未成功时退化为空列表并给出温和提示，不阻塞快速加卡（离线可用）。
 * 本地无结果时**自动兜底**查在线食物库（Open Food Facts，ODbL 1.0）：用户可「加入并记录」，
 * 复用**既有份量确认 → 确认记录**流程；上游不可用时给无负罪感提示。
 */

export type ComposerSubmit =
  | { kind: 'food'; food: FoodItem; grams: number; servingUnit: string; source?: 'search' | 'barcode' }
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

type TabKey = 'search' | 'recent' | 'top' | 'favorite' | 'quick' | 'combo';

/** 常吃榜（R11.5）的统计窗口与展示上限（服务端常量，不开放给用户配置，Q-3）。 */
const TOP_DAYS = FREQUENT_FOOD_DEFAULTS.days;
const TOP_LIMIT = FREQUENT_FOOD_DEFAULTS.limit;
/** 搜索空态里置顶展示的条数（AC-11.5.6）。 */
const TOP_IN_EMPTY_STATE = 5;

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'search', label: '搜索' },
  { key: 'recent', label: '最近' },
  // 常吃榜：位置在「最近」之后（AC-11.5.5）
  { key: 'top', label: COPY.topFoodsTab },
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
  const [selectedSource, setSelectedSource] = useState<'search' | 'barcode'>('search');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [onlineRequested, setOnlineRequested] = useState(false);
  const [onlineBusyId, setOnlineBusyId] = useState<string | null>(null);
  const [grams, setGrams] = useState('100');
  const [servingUnit, setServingUnit] = useState('克');
  const [quickName, setQuickName] = useState('');
  const [quickKcal, setQuickKcal] = useState('');
  /**
   * C1：用户已就重名提示做过选择（「继续用我填的」）。
   *
   * `true` = 已表态，不再探测也不再提示；换名字后重置。**默认放行**：
   * 这个提示存在的意义只是「问一句」，不是拦路。
   */
  const [quickSkippedSameName, setQuickSkippedSameName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  /**
   * 搜索：`GET /foods/search`（**相关度优先**：前缀 > 子串 > 仅别名，同档按 id 稳定分页）。
   *
   * 用 `useInfiniteQuery` 而不是一次取 20 条就结束：食物库 1773 条后，「先出来的是什么」
   * 决定了记录成功率 —— 相关度高的在前，剩下的靠「加载更多」按 `total` 稳定翻页（不跳条、不重复）。
   *
   * ⚠️ `total` 由服务端返回，前端只做「还能不能继续翻」的判断，**不做任何二次排序**
   * （尤其绝不按热量排序：排序口径在 `packages/core` 单一真源，前后端一致）。
   */
  const searchQuery = useInfiniteQuery({
    queryKey: queryKeys.foodSearch(keyword, ''),
    queryFn: ({ pageParam }) =>
      api.get<FoodSearchResponse>('/foods/search', {
        q: keyword,
        page: pageParam,
        pageSize: FOOD_SEARCH_DEFAULT_PAGE_SIZE,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = new Set(allPages.flatMap((page) => page.items.map((item) => item.id))).size;
      return loaded < lastPage.total ? allPages.length + 1 : undefined;
    },
    enabled: tab === 'search' && keyword.trim() !== '',
  });

  /** 已加载的搜索结果：按页拼接 + 按 id 去重（稳定分页下重复只可能是并发兜底）。 */
  const localItems = useMemo((): FoodSearchHit[] => {
    const merged: FoodSearchHit[] = [];
    const seen = new Set<number>();
    for (const page of searchQuery.data?.pages ?? []) {
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          merged.push(item);
        }
      }
    }
    return merged;
  }, [searchQuery.data]);

  /** 命中的总条数（服务端 `total`，用于「加载更多」与「共 N 条」）。 */
  const searchTotal = searchQuery.data?.pages[0]?.total ?? 0;
  /** 还有更多可加载（去重后的已加载数 < 总数）。 */
  const hasMoreSearch = localItems.length < searchTotal;

  const localEmpty = searchQuery.data !== undefined && localItems.length === 0;
  /** 本地为空（或用户主动点「搜索在线食物库」）时才请求在线兜底。 */
  const wantOnline = keyword.trim() !== '' && (localEmpty || onlineRequested);
  const liveQuery = useQuery({
    queryKey: queryKeys.foodLiveSearch(keyword),
    queryFn: () => api.get<LiveSearchResponse>('/foods/live-search', { q: keyword, limit: 10 }),
    enabled: tab === 'search' && wantOnline,
    retry: 0,
  });

  /** 在线兜底是否不可用（上游降级或本地请求不可用）。 */
  const onlineDegraded = liveQuery.data?.degraded === true || liveQuery.isError;

  /**
   * 快速加卡的**同名探测**（C1）：手填名在库里已有同名时，**问一句**。
   *
   * 食物库 443 → 1773 条后，用户手填「番茄炒蛋」库里大概率已经有了；静默创建会
   * 污染个人库、让常吃榜/多样性出现「同物两名」。
   *
   * 这是**提供选择、不是纠正错误**：只做**同名**（或去空白后同名）判定，
   * 判定口径在 `@qsh/core` 单一真源，且**绝不阻断**提交 —— 用户随手可跳过。
   */
  const quickNameTrimmed = quickName.trim();
  const sameNameQuery = useQuery({
    queryKey: queryKeys.foodSearch(quickNameTrimmed, 'quick-add-same-name'),
    queryFn: () => api.get<FoodSearchResponse>('/foods/search', { q: quickNameTrimmed, pageSize: 10 }),
    enabled: tab === 'quick' && quickNameTrimmed !== '' && quickSkippedSameName === false,
    retry: 0,
  });
  /** 命中的库内同名条目（无则不提示，一切照旧）。 */
  const sameNameFood = useMemo(
    () => findSameNameFood(sameNameQuery.data?.items ?? [], quickNameTrimmed),
    [sameNameQuery.data, quickNameTrimmed],
  );

  const recentQuery = useQuery({
    queryKey: queryKeys.foodRecent,
    queryFn: () => api.get<FoodItem[]>('/foods/recent'),
    enabled: tab === 'recent',
  });

  /**
   * 常吃榜（R11.5 / AC-11.5.8）：`GET /foods/top`，与 `recent` / `favorites` **隔离**的独立查询键。
   *
   * 搜索 tab 下也会请求 —— 供**搜索空态置顶**使用（AC-11.5.6）。
   */
  const topQuery = useQuery({
    queryKey: queryKeys.foodTop(TOP_DAYS, TOP_LIMIT),
    queryFn: () => api.get<TopFoodsResponse>('/foods/top', { days: TOP_DAYS, limit: TOP_LIMIT }),
    enabled: tab === 'top' || tab === 'search',
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

  /**
   * 常吃榜：只保留**可反查份量**的条目（`food !== null`）。
   *
   * 快加条目（`foodItemId` 为 `null`）无法反查份量，按 Q-4 **不渲染为可点按钮**。
   */
  const topItems: TopFoodItem[] = (topQuery.data?.items ?? []).filter((item) => item.food !== null);
  /** 搜索空态里置顶的 Top 5（数据不足 → 空数组 → 整块不渲染）。 */
  const emptyStateTopItems = topItems.slice(0, TOP_IN_EMPTY_STATE);

  /**
   * 常吃榜列表项：**只有名称 + 天数**，没有任何营养字段、没有 `role="meter"`（AC-11.5.3 / AC-11.5.4）。
   *
   * 点击行为与 `recent` / `favorite` **完全一致**：走既有 `chooseFood()` → 份量确认 → 确认记录
   * （跳过份量会让热量记录失真，这是硬红线）。
   *
   * UI 规范（`docs/VISUAL-SYSTEM.md`）：圆角用语义令牌 `rounded-control`，
   * 触控目标 `qsh-touch-target`（≥44×44），12px 文字用 `slate-600 / dark:slate-300`（§5 约束）。
   */
  const renderTopList = (items: readonly TopFoodItem[], days: number): ReactElement => (
    <ul className="mt-3 space-y-2">
      {items.map((item) => (
        <li key={item.foodItemId ?? item.name}>
          <button
            type="button"
            onClick={() => {
              if (item.food !== null) {
                chooseFood(item.food);
              }
            }}
            aria-label={topFoodsAria(item.name, item.dayCount, days)}
            className="qsh-touch-target flex w-full items-center justify-between gap-3 rounded-control px-4 py-3 text-left ring-1 ring-brand-100 transition hover:bg-brand-50 dark:ring-slate-700 dark:hover:bg-slate-700"
          >
            <span className="min-w-0 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
              {item.name}
            </span>
            <span className="qsh-tnum shrink-0 text-xs text-slate-600 dark:text-slate-300">
              {topFoodDaysLabel(item.dayCount)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  const chooseFood = (food: FoodItem, source: 'search' | 'barcode' = 'search'): void => {
    const serving = resolveDefaultServing(food);
    setSelected(food);
    setSelectedSource(source);
    setServingUnit(serving.unit);
    setGrams(String(serving.grams));
  };

  /** 加入在线食物（服务端按条码重新拉取 OFF 后幂等入库）→ 复用既有份量确认流程。 */
  const addOnlineFood = async (item: ExternalFoodItem): Promise<void> => {
    setOnlineBusyId(item.externalId);
    setNote(null);
    try {
      const food = await api.post<FoodItem>('/foods/import-external', { externalId: item.externalId });
      chooseFood(food, 'search');
      setNote('已经加入到食物库，确认份量就能记下');
    } catch {
      setNote('这条暂时加不进来，也可以先用「快加」记下');
    } finally {
      setOnlineBusyId(null);
    }
  };

  /** 扫码命中条码 → 后端先本地后在线查，命中即返回可记录的食物。 */
  const handleBarcode = async (code: string): Promise<void> => {
    setScannerOpen(false);
    setNote(null);
    try {
      const result = await api.get<BarcodeLookupResponse>(`/foods/barcode/${code}`);
      if (result.item !== null) {
        chooseFood(result.item, 'barcode');
        setNote('扫码找到啦，确认份量就能记下');
      } else {
        setNote('这次没扫到对应的食物，试试搜索或「快加」');
      }
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) {
        setNote('食物库里还没有这个条码，试试搜索或「快加」');
      } else {
        setNote('扫码暂时没成功，手动搜一下也可以');
      }
    }
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

  /**
   * 食物列表（搜索 / 最近 / 收藏共用）。
   *
   * 搜索结果里的 `qualifier`（区分词，如 `干` / `鲜蘑` / `香辣味`）以中性小标签展示：
   * 跨来源同物异名**不合并**，靠它让用户自己分辨「哪一条是我要的」——
   * 标签只是**事实陈述**（形态 / 口味 / 部位规格），不含任何好坏评价词。
   */
  const renderFoodList = (items: readonly FoodItem[]): ReactElement => (
    <ul className="mt-3 space-y-2">
      {items.map((food) => {
        const qualifier = 'qualifier' in food ? (food as FoodSearchHit).qualifier : null;
        return (
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
                <span className="min-w-0 truncate">{food.name}</span>
                {qualifier !== null && (
                  <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-normal text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                    {qualifier}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-300">
                {food.category} · 每 100g {food.kcalPer100g} kcal
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`记录${MEAL_TYPE_LABELS[mealType]}`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4"
    >
      {/* 底部抽屉/弹窗 → elevation-3（原 shadow-xl 是硬边大阴影，与「柔和」气质冲突） */}
      <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-qsh-3 dark:bg-slate-800 sm:rounded-3xl">
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

        {/* 记录方式标签（「常吃」在数据不足时**整块隐藏**，AC-11.5.2） */}
        <div role="tablist" aria-label="记录方式" className="mt-4 flex gap-1.5 overflow-x-auto">
          {/* tab 显隐与面板渲染**同源**（都用过滤后的 `topItems`）：BUG-QA-01 ——
              榜单里只有快加条目（food 为 null）时，旧写法用未过滤的 items.length
              会让 tab 出现、点进去却是空白面板，违反 AC-11.5.2「不留空卡」。 */}
          {TABS.filter((item) => (item.key === 'top' ? topItems.length > 0 : true)).map((item) => (
            <button
              key={item.key}
              role="tab"
              type="button"
              aria-selected={tab === item.key}
              onClick={() => {
                setTab(item.key);
                setSelected(null);
                setSelectedSource('search');
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
                onChange={(event) => {
                  setKeyword(event.target.value);
                  setOnlineRequested(false);
                }}
                placeholder="如：番茄、米饭、拿铁"
                className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>

            {/* 扫码 / 在线兜底入口 */}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                className="qsh-touch-target rounded-full bg-brand-50 px-4 text-sm text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
              >
                扫码查条码
              </button>
              {keyword.trim() !== '' && (
                <button
                  type="button"
                  onClick={() => setOnlineRequested(true)}
                  className="qsh-touch-target rounded-full bg-brand-50 px-4 text-sm text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
                >
                  搜索在线食物库
                </button>
              )}
            </div>

            {searchQuery.isFetching && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">搜索中…</p>}
            {searchQuery.data !== undefined && renderFoodList(localItems)}

            {/* 结果完整性（阶段 2.4）：把服务端的 `total` 如实呈现，并给「加载更多」。
                顺序完全由服务端相关度决定，前端不重排、不筛选、不做任何评价。 */}
            {searchQuery.data !== undefined && localItems.length > 0 && (
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  共 {searchTotal} 条，已显示 {localItems.length} 条
                </span>
                {hasMoreSearch && (
                  <button
                    type="button"
                    onClick={() => void searchQuery.fetchNextPage()}
                    disabled={searchQuery.isFetchingNextPage}
                    className="qsh-touch-target shrink-0 rounded-full bg-brand-50 px-4 text-sm text-brand-700 disabled:opacity-60 dark:bg-brand-900/40 dark:text-brand-200"
                  >
                    {searchQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
                  </button>
                )}
              </div>
            )}

            {/* 搜索空态置顶「你常吃的」（R11.5 / AC-11.5.6）：
                **只在搜索结果为空时**渲染；有结果时整块不出现，不干扰 ≤3 次点击。
                位置在「没有找到这条食物」那条空态文案**之前**。 */}
            {keyword.trim() !== '' &&
              localEmpty &&
              !searchQuery.isFetching &&
              emptyStateTopItems.length > 0 && (
                <div className="mt-3" data-testid="top-foods-empty-state">
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                    {COPY.topFoodsTitle}
                  </h3>
                  {renderTopList(emptyStateTopItems, topQuery.data?.days ?? TOP_DAYS)}
                </div>
              )}

            {/* 本地为空 → 在线兜底（Open Food Facts，ODbL 1.0） */}
            {keyword.trim() !== '' && localEmpty && !searchQuery.isFetching && (
              <div className="mt-3">
                {liveQuery.isFetching && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">本地没有，正在帮你找在线食物库…</p>
                )}

                {onlineDegraded && (
                  <p className="rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
                    在线食物库暂时连不上，先用本地结果或「快加」记下也没问题。
                  </p>
                )}

                {liveQuery.data !== undefined &&
                  !liveQuery.data.degraded &&
                  liveQuery.data.items.length > 0 && (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">在线结果</h3>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:bg-slate-700 dark:text-slate-300">
                          Open Food Facts · ODbL 1.0
                        </span>
                      </div>
                      <ul className="mt-2 space-y-2">
                        {liveQuery.data.items.map((item) => (
                          <li
                            key={item.externalId}
                            className="rounded-xl px-4 py-3 ring-1 ring-brand-100 dark:ring-slate-700"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                                  {item.name}
                                </p>
                                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-300">
                                  {item.brand !== null ? `${item.brand} · ` : ''}每 100g {item.kcalPer100g} kcal
                                </p>
                              </div>
                              <button
                                type="button"
                                disabled={onlineBusyId !== null}
                                onClick={() => void addOnlineFood(item)}
                                className="qsh-touch-target shrink-0 rounded-lg bg-brand-100 px-3 text-sm font-medium text-brand-700 disabled:opacity-60 dark:bg-brand-900 dark:text-brand-200"
                              >
                                {onlineBusyId === item.externalId ? '加入中…' : '加入并记录'}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                        数据来自 Open Food Facts（ODbL 1.0），加入后会存到你的食物库。
                      </p>
                    </>
                  )}

                {liveQuery.data !== undefined &&
                  !liveQuery.data.degraded &&
                  liveQuery.data.items.length === 0 && (
                    <p className="text-sm text-slate-500 dark:text-slate-400">没有找到这条食物，试试「快加」</p>
                  )}
              </div>
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
                  <p className="flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                    <BrandDecor variant="bloom" className="h-4 w-4 shrink-0 text-brand-300" />
                    {tab === 'recent' ? '还没有记录过食物' : '还没有收藏的食物'}
                  </p>
                );
              }
              return renderFoodList(items);
            })()}
          </div>
        )}

        {/* 常吃榜（R11.5）：点击行为与「最近 / 收藏」完全一致（份量确认 → 确认记录）。
            数据不足（< 3 天）时**整块不渲染** —— 不留空卡、不给引导语（AC-11.5.2）。
            读取中与「最近 / 收藏」保持同一种提示，避免面板空白被误读成「什么都没有」。 */}
        {tab === 'top' && (
          <div className="mt-4">
            {topQuery.isLoading ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">读取中…</p>
            ) : (
              topItems.length > 0 && (
                <>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    近 {topQuery.data?.days ?? TOP_DAYS} 天里出现得最多的几样，只按频次排，不代表任何评价。
                  </p>
                  {renderTopList(topItems, topQuery.data?.days ?? TOP_DAYS)}
                </>
              )
            )}
          </div>
        )}

        {/* 快速加卡：仅名称 + 热量（R3.5 / TC-19） */}
        {tab === 'quick' && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm text-slate-600 dark:text-slate-300">
              名称
              <input
                value={quickName}
                onChange={(event) => {
                  setQuickName(event.target.value);
                  // 换了名字，之前的「已跳过」表态作废，重新问一次
                  setQuickSkippedSameName(false);
                }}
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

            {/*
              C1 · 同名温和提示：**提供选择，不是纠正错误**。
              只问一句、一键可跳过、不阻断提交（G1「3 次点击记一餐」优先）。
            */}
            {sameNameFood !== null && !quickSkippedSameName && (
              <div
                data-testid="quick-same-name-notice"
                className="rounded-xl bg-brand-50 px-3 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
              >
                <p>
                  库里已经有「{sameNameFood.name}」了，用它吗？也可以继续用你填的。
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="qsh-touch-target rounded-lg bg-brand-100 px-3 py-1 font-medium text-brand-700 dark:bg-brand-900 dark:text-brand-200"
                    onClick={() => {
                      setQuickName(sameNameFood.name);
                      setQuickKcal(String(Math.round(sameNameFood.kcalPer100g)));
                      setQuickSkippedSameName(true);
                    }}
                  >
                    用库里的（{toDisplayEnergy(sameNameFood.kcalPer100g, unit)} {energyLabel(unit)}/100g）
                  </button>
                  <button
                    type="button"
                    className="qsh-touch-target rounded-lg px-3 py-1 text-brand-600 underline dark:text-brand-300"
                    onClick={() => setQuickSkippedSameName(true)}
                  >
                    继续用我填的
                  </button>
                </div>
              </div>
            )}
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
                void run({ kind: 'food', food: selected, grams: gramsValue, servingUnit, source: selectedSource });
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

      {scannerOpen && (
        <BarcodeScanner
          onClose={() => setScannerOpen(false)}
          onDetected={(code) => void handleBarcode(code)}
        />
      )}
    </div>
  );
}
