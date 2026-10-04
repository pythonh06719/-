import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FOOD_CATEGORIES,
  FOOD_SEARCH_DEFAULT_PAGE_SIZE,
  FREQUENT_FOOD_DEFAULTS,
  addPendingItem,
  findSameMealItem,
  findSameNameFood,
  foodCategoryLabel,
  isPendingListRecordable,
  removePendingItem,
  resolveLastPortionServing,
  setPendingItemGramsText,
  toBatchItems,
} from '@qsh/core';
import type { BatchMealItem, MealItemIdentity, PendingMealItem } from '@qsh/core';
import type {
  BarcodeLookupResponse,
  ExternalFoodItem,
  FoodItem,
  FoodSearchHit,
  FoodSearchResponse,
  LastPortionsResponse,
  LiveSearchResponse,
  MealComboWithItems,
  MealType,
  TopFoodItem,
  TopFoodsResponse,
} from '@qsh/shared-types';
import { ApiClientError, api } from '@/lib/api';
import BarcodeScanner from '@/components/common/BarcodeScanner';
import { queryKeys } from '@/lib/queryClient';
import {
  COPY,
  favoriteToggleAria,
  foodCategoryAriaFor,
  foodHistoryToggleAria,
  topFoodDaysLabel,
  topFoodsAria,
  topFoodsLastLoggedLabel,
} from '@/lib/copy';
import { emojiForCategory } from '@/lib/food-emoji';
import { formatMonthDay, isDateKey } from '@/lib/format';
import { energyLabel, toDisplayEnergy, useUnitStore } from '@/lib/units';
import BrandDecor from '@/components/common/BrandDecor';
import FoodHistoryPanel from './FoodHistoryPanel';
import { MEAL_TYPE_LABELS, computeKcalFromFood, resolveDefaultServing } from './meal-utils';

/**
 * 记录一餐面板（pages/diary/MealComposer.tsx）—— 六种记录方式（R3.4/R3.5/R3.8/R3.9）
 * + 分类浏览（A2）+ 在线食物库兜底 + 条码扫码（Phase C-1 / C-2）。
 *
 * **★ 3 次点击完成记录（TC-25）**：打开面板（1）→ 选食物（2）→ 点「确认记录」（3）。
 * 最近 / 收藏 / 套餐均为「一次点击直接确认」，更快。
 *
 * 搜索 / 最近 / 收藏 / 套餐接口未成功时退化为空列表并给出温和提示，不阻塞快速加卡（离线可用）。
 * 本地无结果时**自动兜底**查在线食物库（Open Food Facts，ODbL 1.0）：用户可「加入并记录」，
 * 复用**既有份量确认 → 确认记录**流程；上游不可用时给无负罪感提示。
 *
 * **D-5 食用历史**：每一行食物（搜索 / 最近 / 收藏 / 分类）带一个**次级**「历史」动作，
 * 展开该食物在本人记录里的**只读**日期明细（`FoodHistoryPanel`）。补上「常吃榜之外
 * 无处可查上次吃到什么时候」的缺口；详见该组件顶部的红线说明。
 */

export type ComposerSubmit =
  | { kind: 'food'; food: FoodItem; grams: number; servingUnit: string; source?: 'search' | 'barcode' }
  | { kind: 'quick'; name: string; kcal: number }
  | { kind: 'combo'; comboId: number }
  /**
   * C-3 一餐多品项批量记录：一次把整份**待记清单**写入同一餐次。
   *
   * `items` 由 `@qsh/core` 的 `toBatchItems()` 从清单算出（含逐条克数与内部热量预估）；
   * 父组件负责把它转成 `POST /meals/batch` 请求（单事务写入）。
   */
  | { kind: 'batch'; items: BatchMealItem[] };

export interface MealComposerProps {
  /** 记录日期（`YYYY-MM-DD`） */
  date: string;
  /** 餐次 */
  mealType: MealType;
  /** 关闭面板 */
  onClose: () => void;
  /** 提交（由父组件负责入库 / 离线队列 / 反馈） */
  onSubmit: (payload: ComposerSubmit) => Promise<void>;
  /**
   * D-2「重复记录温和提示」：**这一天已有的记录**（最小投影，含 `loggedDate` / `mealType` /
   * `foodItemId` / `customName`）。
   *
   * 由父组件（`DiaryPage`）从当天的 `mealsQuery` 传入 —— 面板本身不另发请求。
   * 判定口径在 `@qsh/core` 的 `findSameMealItem`（同一天 + 同一餐 + 同一样）。
   *
   * ⚠️ **可选**，缺省 `[]`（不给就不提示）：既有调用方 / 测试无需改动，行为与从前一致。
   * ⚠️ 它只用于**呈现一句觉察**，**绝不参与提交路径**（默认放行，见本文件 `sameMealMatches`）。
   */
  existingMealItems?: readonly MealItemIdentity[];
}

type TabKey = 'search' | 'category' | 'recent' | 'top' | 'favorite' | 'quick' | 'combo';

/** 常吃榜（R11.5）的统计窗口与展示上限（服务端常量，不开放给用户配置，Q-3）。 */
const TOP_DAYS = FREQUENT_FOOD_DEFAULTS.days;
const TOP_LIMIT = FREQUENT_FOOD_DEFAULTS.limit;
/** 搜索空态里置顶展示的条数（AC-11.5.6）。 */
const TOP_IN_EMPTY_STATE = 5;
/**
 * 分类查询缓存键里的第三段 sentinel。
 *
 * `queryKeys.foodSearch(keyword, category)` 的第三段是**关键词**；搜索功能只会传用户输入
 * （空则 `enabled` 为 false，并不发请求）。分类浏览没有关键词，若这一位也留空，
 * 键就会与「空关键词的搜索」完全重合。用这个绝不会被用户输入出来的字符串占位，
 * 让「分类查询的键」与「搜索查询的键」从**键本身**就区分开（见 `categoryQuery` 注释）。
 */
const CATEGORY_QUERY_KEYWORD_SENTINEL = '\u0000category';

/**
 * 勾选框的形态：**圆形**，与全站胶囊/圆形语言一致（`docs/VISUAL-SYSTEM.md` §2）。
 *
 * ## 为什么不用浏览器默认方块
 *
 * 全站没有第二处原生 checkbox 可参照，故形态依据取自**同一份设计语言里最接近的两个角色**：
 * ① 记录方式 tab 与分类 chip —— `rounded-full` 胶囊；② 提醒开关（`pages/profile/
 * ReminderSettings.tsx`）—— `rounded-full` 胶囊 + 品牌色实心为「开」。两者都指向
 * 「圆」而不是「方」。故未选中态做成**描边圆**，选中态做成**品牌色实心圆 + 白色对勾**。
 *
 * ## 实现要点
 *
 * - `appearance-none` 去掉浏览器原生绘制（否则 `rounded-*` / `bg-*` 会被原生外观覆盖，
 *   这正是此前「加了圆角仍是灰方块」的原因）；
 * - 选中态**只加强不弱化**：实心品牌色 + 白色对勾，对比度高于未选中的描边圆；
 * - 对勾是**白色**描边 SVG，无红/黄等警示色（产品红线）；
 * - 触控目标由外层 `<label>` 承担（整行可点），圆点本身 `h-5 w-5` 只作视觉锚点。
 */
const CHECKBOX_CLASS =
  'h-5 w-5 shrink-0 cursor-pointer appearance-none rounded-full border-2 border-slate-300 bg-white bg-[length:0.625rem] bg-center bg-no-repeat transition duration-qsh-fast ease-qsh-out checked:border-brand-600 checked:bg-brand-600 dark:border-slate-500 dark:bg-slate-900 dark:checked:border-brand-500 dark:checked:bg-brand-500';

/**
 * 选中态叠加的**白色对勾**。
 *
 * 走内联 `style` 而非 Tailwind 任意值 `bg-[url(...)]`：data URI 里的 `%22` / `%27` 会被
 * Tailwind 当成字面量，方括号被剥掉后浏览器把整串当成**相对 URL** 去请求
 * （实测 `background-image` 变成了 `url("http://…/%22data:image/svg+xml,…")`），
 * 对勾静默不显示。内联 style 没有这层转义。
 */
const CHECK_MARK_STYLE = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2 6l2.5 2.5L10 3.5'/%3E%3C/svg%3E\")",
} as const;

/**
 * 常吃榜「上次食用日期」的**已格式化**月日（「9月8日」）—— 行内小字与 aria **共用**同一份，
 * 保证视觉用户与读屏用户看到/听到的是同一句话（NFR-7）。
 *
 * 口径：**零新计算**。日期由 `@qsh/core` 的 `FrequentFood.lastLoggedDate` 算好、
 * 经 `TopFoodItem` 原样透传；这里只做「合法就格式化、不合法就空串」，
 * **不算「隔了多少天」、不给任何评价**。
 *
 * 防御（旧缓存 / 脏数据：字段可能不是合法日期键）→ 返回 `''`，**整句不渲染**，
 * 既不猜一个日期、也不兜底成「未知 / 暂无」这类把缺失说成亏欠的文案。
 */
function topFoodLastLoggedMonthDay(dateKey: string | undefined): string {
  if (typeof dateKey !== 'string' || !isDateKey(dateKey)) {
    return '';
  }
  return formatMonthDay(dateKey);
}

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'search', label: '搜索' },
  // 分类浏览（A2）：紧挨「搜索」，对应 PRD §4.3 R3.4 的「搜索 / 分类浏览」并列说法
  { key: 'category', label: COPY.foodCategoryTab },
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
  existingMealItems,
}: MealComposerProps): ReactElement {
  const unit = useUnitStore((state) => state.unit);
  const [tab, setTab] = useState<TabKey>('search');
  const [keyword, setKeyword] = useState('');
  /**
   * 分类浏览（A2）当前选中的分类；`null` = 还没选（只显示 chip 行 + 一句引导）。
   *
   * 只存**分类名本身**，不存下标，也不写死任何分类字面量 —— 有哪些分类完全由
   * `GET /foods/categories` 决定。**展示顺序**另由 `orderedCategories` 按
   * `FOOD_CATEGORIES` 重排（服务端给的是码点序，`other` 会在首位），见下方注释。
   */
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
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
  /**
   * C-4 第一步：快加时**是否顺手存进食物库**（默认不勾）。
   *
   * 为什么默认不勾：食物库的价值来自**重复吃的东西**。一次性条目（某家店的某道菜、
   * 出门随手记的一顿）存进去只会让「最近 / 搜索」变噪音；而真正常吃的（每天早餐、
   * 常点的那杯拿铁）用户自己清楚，勾一次终身受益。默认不打勾，把选择权留给用户，
   * 不替用户决定什么值得存。
   */
  const [quickSaveToLibrary, setQuickSaveToLibrary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /**
   * D-1「上次份量记忆」：本次选中的食物用的是**上次记的克数**时，记下那个克数，用于
   * 在份量确认区显示一句中性小字（「上次记的是 300g」）。
   *
   * `null` = 这次没用历史（回落食物库默认份量）→ 不显示提示。
   * 只存「展示用的一句话所需的最小数据」；不参与任何热量的计算。
   */
  const [lastPortionGrams, setLastPortionGrams] = useState<number | null>(null);

  /**
   * D-5：当前展开「食用历史」的食物 id；`null` = 都没展开。
   *
   * 用**单一 id** 而非 `Set<number>`：一次只展开一行。理由是「选食物」这件事必须
   * 始终是列表里的主操作，一屏多个历史列表会把它淹没；而用户的问题通常只关于
   * 眼前这一行。再点同一行收起（`toggleHistory`）。
   *
   * 纯 UI 状态：**不发任何写请求**，也不参与提交。
   */
  const [historyFoodId, setHistoryFoodId] = useState<number | null>(null);

  /**
   * C-3 多选模式开关。
   *
   * **为什么用「开关」而不是新 tab**：多选是**正交于来源**的 —— 用户可能在搜索 /
   * 分类 / 常吃 / 收藏任何一处想「多选」，把它做成第 8 个 tab 会逼用户先选来源再选
   * 模式（且要么复制一套列表、要么只能在单一来源里多选）。开关则是一处布尔状态，
   * 复用到**所有**渲染食物行的 tab 上，「点一行」的含义随开关切换。
   *
   * **默认关闭**且**不改变任何既有路径**：关闭时行为与从前逐字节一致（G1「≤3 次
   * 点击记一餐」不受影响）。
   */
  const [multiSelect, setMultiSelect] = useState(false);
  /**
   * 待记清单（C-3）：多选模式下「点食物 → 加进这里」的累积列表。
   *
   * 状态机（去重 / 移除 / 改份量 / 提交校验）在 `@qsh/core` 的 `meal/batch.ts` 单一真源，
   * 本组件只做渲染与事件接线 —— 这样「重复点同一样不产生两行」这类口径可被单测钉死。
   */
  const [pendingItems, setPendingItems] = useState<PendingMealItem[]>([]);

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

  /**
   * D-2「重复记录温和提示」：这一餐里是不是**已经有它了**。
   *
   * ## 三个入口同源 —— 都调 `@qsh/core` 的 `findSameMealItem`（判定只有一份实现）
   *
   * - `selected`：选中某条**食物库食物**后，看当天同餐里有没有同 `foodItemId` 的记录；
   * - `quick`：**快加**填了名称后，看当天同餐里有没有同名（去空白后同名）的自定义记录；
   * - `pending`：多选清单里**任意一项**已记过（C-3 批量路径同样给觉察）。
   *
   * ## 🔴 默认放行（本功能成败的关键）
   *
   * 这可能**真的不是重复**（用户可能就是又吃了一碗饭），所以：
   * - 它只驱动一句**中性小字**，**不是弹窗、不是红色、不要求确认**；
   * - 它**不参与**任何提交判断 —— `submitBatch` / 确认按钮 / `onSubmit` 都读不到它的结果，
   *   用户无视它继续记，**照常成功**（测试里「默认放行」那条把这一点锁死）。
   *
   * 作用域（同一天 + 同一餐）由 `findSameMealItem` 自身按 `loggedDate` + `mealType` 过滤，
   * 故早餐已记、午餐再记同一食物**不会**提示（那是正常的）。
   */
  const sameMealMatches = useMemo(() => {
    const existing = existingMealItems ?? [];
    const scope = { loggedDate: date, mealType };
    return {
      selected:
        selected === null
          ? null
          : findSameMealItem(existing, { ...scope, foodItemId: selected.id }),
      quick:
        quickNameTrimmed === ''
          ? null
          : findSameMealItem(existing, { ...scope, customName: quickNameTrimmed }),
      pending: pendingItems.some(
        (entry) => findSameMealItem(existing, { ...scope, foodItemId: entry.foodId }) !== null,
      ),
    };
  }, [existingMealItems, date, mealType, selected, quickNameTrimmed, pendingItems]);

  /**
   * 分类浏览（A2 / R3.4）：`GET /foods/categories` → 分类 chip 行。
   *
   * ⚠️ 服务端给的是**码点序**（`orderBy: { category: 'asc' }` 落在 SQLite 上即 Unicode
   * 码点比较），不是展示序：`other`（`o` = U+006F）会排在所有汉字**之前**，
   * 于是用户打开分类 tab 第一个看到的是一个英文分类，其余也是「码点序」而非拼音序
   * （如 `家常菜` 夹在 `奶茶` 与 `水果` 之间）。**渲染顺序在下方按 `FOOD_CATEGORIES` 重排**。
   *
   * 这**不引入任何新数字**：只用一个字符串数组，`/why-numbers` 无需新增条目（NFR-11）。
   */
  const categoriesQuery = useQuery({
    queryKey: queryKeys.foodCategories,
    queryFn: () => api.get<string[]>('/foods/categories'),
    enabled: tab === 'category',
  });

  /**
   * 分类展示顺序：按 `FOOD_CATEGORIES`（`@qsh/core`，其模块注释明确「顺序即展示顺序」）。
   *
   * `FOOD_CATEGORIES` 已包含 `other`，故它会被正常映射到**末尾**。
   * 两个必须守住的边界：
   * - **`indexOf` 为 `-1` 的未知分类排最后**：不能让它以 `-1` 参与比较而插到队首
   *   （后端将来新增分类时就会走到这里）；
   * - **不丢数组外的分类**：新分类照常显示，只是排在已知分类之后 ——
   *   「不丢数据」优先于「顺序漂亮」。
   *
   * 显式用「一级键 = 已知序号 / 未知 = 无限大，二级键 = 原下标」比较，
   * 这样即使将来换成不稳定排序实现，相对顺序也不会漂。
   */
  const orderedCategories = useMemo((): string[] => {
    const rank = (category: string): number => {
      const index = FOOD_CATEGORIES.indexOf(category as (typeof FOOD_CATEGORIES)[number]);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    };
    return (categoriesQuery.data ?? [])
      .map((category, originalIndex) => ({ category, originalIndex }))
      .sort((a, b) => {
        const diff = rank(a.category) - rank(b.category);
        return diff !== 0 ? diff : a.originalIndex - b.originalIndex;
      })
      .map((entry) => entry.category);
  }, [categoriesQuery.data]);

  /**
   * 「看某分类下有什么」（A2）：同一个搜索端点，**关键词留空 + 带 `category`**。
   *
   * 为什么不复用 `searchQuery`：它的 `enabled` 是 `keyword.trim() !== ''`，
   * 空关键词直接不发请求 —— 纯分类浏览会被拦死；改它又会牵连搜索功能的既有测试。
   * 两条查询各自独立，互不影响。
   *
   * ⚠️ 刻意**不接** `/foods/live-search`：分类浏览回答的是「库里有什么」，
   * 语义上不该把 Open Food Facts 的在线结果混进来（搜索 tab 仍保留那条兜底）。
   * ⚠️ 也**不接**常吃榜：`topQuery` 的 enabled 保持 `tab === 'top' || tab === 'search'` 不动。
   */
  const categoryQuery = useInfiniteQuery({
    // 缓存键第三段**绝不能**与搜索撞车：搜索是 `foodSearch(keyword, '')`，keyword 为空时
    // 也是 `['foods','search','','']` —— 若这里在未选中分类时退化成同一个键，两条查询就会
    // 共用缓存（目前只靠 enabled 不同侥幸不冲突，一旦有人改 enabled 就会把分类结果串进搜索）。
    // 故第三段固定用 `'category'` 这个搜索永远不会传入的 sentinel，与 `enabled`
    // 「selectedCategory 非空才请求」解耦：键唯一由键本身保证，不靠不变量维系。
    queryKey: queryKeys.foodSearch(CATEGORY_QUERY_KEYWORD_SENTINEL, selectedCategory ?? ''),
    queryFn: ({ pageParam }) =>
      api.get<FoodSearchResponse>('/foods/search', {
        q: '',
        category: selectedCategory ?? '',
        page: pageParam,
        pageSize: FOOD_SEARCH_DEFAULT_PAGE_SIZE,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = new Set(allPages.flatMap((page) => page.items.map((item) => item.id))).size;
      return loaded < lastPage.total ? allPages.length + 1 : undefined;
    },
    enabled: tab === 'category' && selectedCategory !== null,
  });

  /** 分类浏览里已加载的条目：按页拼接 + 按 id 去重（与搜索同款，稳定分页下不会重复）。 */
  const categoryItems = useMemo((): FoodSearchHit[] => {
    const merged: FoodSearchHit[] = [];
    const seen = new Set<number>();
    for (const page of categoryQuery.data?.pages ?? []) {
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          merged.push(item);
        }
      }
    }
    return merged;
  }, [categoryQuery.data]);

  /** 该分类的总条数（服务端 `total`，既有口径）。 */
  const categoryTotal = categoryQuery.data?.pages[0]?.total ?? 0;
  const hasMoreCategory = categoryItems.length < categoryTotal;

  /** 已加载但该分类下一条都没有（接口降级 / 数据变动才会出现）。 */
  const categoryEmpty =
    selectedCategory !== null &&
    categoryQuery.data !== undefined &&
    categoryItems.length === 0;

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

  /**
   * 收藏列表（R3.4）—— `GET /foods/favorites` 返回 `FoodItem[]`。
   *
   * **它同时充当两件事**（GAP-1 的取舍，见下方 `favoriteIds`）：
   * ① 收藏 tab 的列表数据；② 全列表「某条是否已收藏」的**唯一真源**。
   *
   * `enabled` 从 `tab === 'favorite'` 放宽到**会渲染食物行的四个 tab**
   * （`favorite` / `recent` / `category` / `search`）：
   * 要在这些 tab 的每一行画星号，就必须知道该行的收藏状态，而 `FoodItem` 上
   * **没有任何表达「已收藏」的字段**（见 `packages/shared-types` 的 `FoodItem`），
   * 只能另取一次收藏 id 集合。**为什么不干脆全开**：`top` 走 `renderTopList`（无星号）、
   * `quick` / `combo` 根本不渲染食物行 —— 对它们请求收藏纯属浪费。故只在这四个
   * 「会显示星号」的 tab 上取，请求数**从 1 个 tab 增到 4 个 tab**，且同一会话内
   * 由 react-query 缓存去重（`queryKeys.foodFavorites` 共用），实际网络次数远小于 tab 切换次数。
   *
   * `search` / `category` 额外要求「确实会有结果」才请求：空关键词的搜索、未选分类的分类页
   * 都不渲染任何食物行，此时请求收藏同样无意义（与各自列表查询的 `enabled` 条件对齐）。
   */
  const favoriteQuery = useQuery({
    queryKey: queryKeys.foodFavorites,
    queryFn: () => api.get<FoodItem[]>('/foods/favorites'),
    enabled:
      tab === 'favorite' ||
      tab === 'recent' ||
      (tab === 'category' && selectedCategory !== null) ||
      (tab === 'search' && keyword.trim() !== ''),
  });

  /**
   * 「已收藏食物的 id 集合」——星号按钮判断每行状态用。
   *
   * `FoodItem` 上**没有** `favorited` 字段（已核对 `packages/shared-types`），
   * 因此状态只能从收藏列表反推：集合 = `favoriteQuery.data` 的 id。
   *
   * ⚠️ 加载中 / 未取到时集合为**空**：此时所有星号都呈「未收藏」。
   * 这是**刻意的保守取舍** —— 宁可暂时显示成「未收藏」（用户点一下会变成收藏，
   * 幂等的 `upsert` 保证不会出问题），也**不**把整行列表挡住、不显示 loading 骨架。
   * 一旦收藏查询返回，集合立即就位（star 状态刷新）。
   */
  const favoriteIds = useMemo((): ReadonlySet<number> => {
    // 防御：接口降级 / 契约不符时 `data` 可能不是数组（历史测试里 `GET /foods/favorites`
    // 会命中通用兜底返回 `{}`）。此处按「拿不到集合」处理（空集），绝不让整页挂掉。
    const list = Array.isArray(favoriteQuery.data) ? favoriteQuery.data : [];
    return new Set(list.map((food) => food.id));
  }, [favoriteQuery.data]);

  const queryClient = useQueryClient();

  /**
   * 收藏切换（R3.4 / GAP-1）—— `POST /foods/:id/favorite` / `DELETE /foods/:id/favorite`。
   *
   * 后端两个端点都**幂等**（`addFavorite` 用 `upsert`、`removeFavorite` 用 `deleteMany`），
   * 故前端不必先判状态再决定调哪个 —— 但为语义清晰仍按 `next` 显式分支。
   *
   * 成功后**就地更新缓存**（`setQueryData`），不整页刷新：
   * 收藏列表是「已收藏 id 集合」的同一份数据，改它就同时刷新了列表与所有星号。
   * - 加藏：把该食物**插到最前**（与后端 `ORDER BY created_at DESC` 口径一致，
   *   用户刚收藏的立刻在收藏 tab 顶部可见）；
   * - 取消：按 id 过滤掉。
   * 两处都做**去重**（加藏前先滤掉同 id），保证重复点不会在列表里留两条。
   *
   * 失败：`onError` 里 `invalidateQueries` 回滚到服务端真值，并给一句温和提示
   * （`COPY.favoriteFailed`），不用红色、不提失败次数。
   */
  const favoriteMutation = useMutation({
    mutationFn: async ({ food, next }: { food: FoodItem; next: boolean }): Promise<void> => {
      if (next) {
        await api.post<{ favorited: true }>(`/foods/${food.id}/favorite`);
      } else {
        await api.delete<{ favorited: false }>(`/foods/${food.id}/favorite`);
      }
    },
    onSuccess: (_data, variables) => {
      queryClient.setQueryData<FoodItem[]>(queryKeys.foodFavorites, (current) => {
        // 防御：缓存里的旧值可能不是数组（契约不符 / 兜底响应），一律当空列表处理
        const list = Array.isArray(current) ? current : [];
        const without = list.filter((item) => item.id !== variables.food.id);
        return variables.next ? [variables.food, ...without] : without;
      });
    },
    onError: () => {
      // 回滚到服务端真值，避免界面停在一个没真正存下的状态上
      void queryClient.invalidateQueries({ queryKey: queryKeys.foodFavorites });
      setNote(COPY.favoriteFailed);
    },
  });

  /** 点星号：按当前状态决定加还是取消（`aria-pressed` 与这里同源，不会出现「显示的」和「做的」不一致）。 */
  const toggleFavorite = (food: FoodItem): void => {
    favoriteMutation.mutate({ food, next: !favoriteIds.has(food.id) });
  };

  /**
   * D-5：展开 / 收起某个食物的**食用历史**（只读）。
   *
   * **同一时刻最多展开一个**（单一 state 而非 `Set`）：一屏塞多个历史列表会把
   * 「选食物」这件事淹没掉，而用户的问题通常只关于眼前这一行。再点一次收起。
   *
   * ⚠️ 纯 UI 状态，**不发任何写请求** —— 历史列表是「查看」，不是「记录」。
   */
  const toggleHistory = (foodId: number): void => {
    setHistoryFoodId((current) => (current === foodId ? null : foodId));
  };

  const comboQuery = useQuery({
    queryKey: queryKeys.combos,
    queryFn: () => api.get<MealComboWithItems[]>('/meal-combos'),
    enabled: tab === 'combo',
  });

  useEffect(() => {
    // ⚠️ `favoriteQuery` 现在在 recent / search / category 等 tab 上也会跑（见其 `enabled`），
    // 但那些 tab 的**主内容**不是收藏列表 —— 若只因收藏那一次请求失败就弹「内容取不到」，
    // 会和用户眼前**正常显示的**搜索结果自相矛盾。故收藏查询的失败**只在收藏 tab 上**计入。
    const favoriteFailedOnItsTab = favoriteQuery.isError && tab === 'favorite';
    if (searchQuery.isError || recentQuery.isError || favoriteFailedOnItsTab || comboQuery.isError) {
      setNote('这部分内容暂时取不到，先用「快加」也能记下这一餐');
    }
  }, [searchQuery.isError, recentQuery.isError, favoriteQuery.isError, comboQuery.isError, tab]);

  /**
   * 分类浏览的两条查询失败 → 同一句温和提示（文案与全站既有口径一致）。
   * 用 `role="status"` 的 `note` 呈现，而不是在列表区留一张空卡。
   */
  useEffect(() => {
    if (categoriesQuery.isError || categoryQuery.isError) {
      setNote(COPY.foodCategoryLoadFailed);
    }
  }, [categoriesQuery.isError, categoryQuery.isError]);

  /**
   * 换分类 / 取消分类都会把列表**整体换掉**，此时必须收起上一轮选中的食物。
   *
   * 否则「选了一条食物 → 份量确认区弹出 → 再点另一个 chip」时，`selected` 会残留，
   * 份量确认区继续对着**上一条食物**，与刚刷新出来的列表打架 —— 用户会以为
   * 那个份量区是为新列表准备的。
   *
   * 用 `useEffect` 监听而不是写在内联 onClick 里：一次覆盖「改选中」与「取消选中」
   * 两条路径，将来若再新增改分类的入口（例如清空按钮）也不会漏。
   * 首次挂载时 `selected` 本就是 `null`，这次 `setSelected(null)` 是无害的 no-op，
   * 无需「跳过首次」的特判。
   *
   * 注：切 tab 时原有的 `setSelected(null)` **保留不动**（两条路径职责不同，
   * 切 tab 还会重置 `selectedSource`）。
   */
  useEffect(() => {
    setSelected(null);
  }, [selectedCategory]);

  /**
   * 常吃榜：只保留**可反查份量**的条目（`food` 非空）。
   *
   * 快加条目（`foodItemId` 为 `null`）无法反查份量，按 Q-4 **不渲染为可点按钮**。
   *
   * ⚠️ 用 `!= null` 而非 `!== null`：`food` 是**前后端边界**上的字段，
   * 若后端某天漏发该键（`undefined` 而非 `null`），`undefined !== null` 为真会把
   * 这条**无 `food` 的脏数据放进 topItems**，随后 `item.food.id` 直接解引用 `undefined` 抛错。
   * 契约上 `food` 恒为 `null | 对象`（`@qsh/shared-types`的 `TopFoodItem`），
   * 故这是**防御性**而非现网可修的 bug —— 但边界校验按项目约定不砍（同 `lib/api.ts`）。
   */
  const topItems: TopFoodItem[] = (topQuery.data?.items ?? []).filter((item) => item.food != null);
  /** 搜索空态里置顶的 Top 5（数据不足 → 空数组 → 整块不渲染）。 */
  const emptyStateTopItems = topItems.slice(0, TOP_IN_EMPTY_STATE);

  /**
   * **上次份量记忆**（D-1）：当前列表里出现的食物 id 集合（去重、升序）。
   *
   * 只对**正在渲染的那一屏**食物预取「上次份量」—— 用户点下去时默认值已就绪，
   * 既不多一次点击，也不会出现「先显示默认、再跳成上次值」的抖动。
   */
  const visibleFoodIds = useMemo((): number[] => {
    const ids = new Set<number>();
    if (tab === 'search') {
      for (const food of localItems) ids.add(food.id);
      for (const item of emptyStateTopItems) {
        if (item.food != null) ids.add(item.food.id);
      }
    } else if (tab === 'category') {
      for (const food of categoryItems) ids.add(food.id);
    } else if (tab === 'recent') {
      for (const food of Array.isArray(recentQuery.data) ? recentQuery.data : []) ids.add(food.id);
    } else if (tab === 'favorite') {
      for (const food of Array.isArray(favoriteQuery.data) ? favoriteQuery.data : []) ids.add(food.id);
    } else if (tab === 'top') {
      for (const item of topItems) {
        if (item.food != null) ids.add(item.food.id);
      }
    }
    return [...ids].sort((a, b) => a - b);
  }, [
    tab,
    localItems,
    emptyStateTopItems,
    categoryItems,
    recentQuery.data,
    favoriteQuery.data,
    topItems,
  ]);

  /**
   * 批量取「上次份量」（D-1）：`GET /foods/last-portions?ids=...` —— 一次请求覆盖整屏食物。
   *
   * 失败 / 离线 → `data` 为 `undefined` → `chooseFood` **静默回落**到食物库默认份量，
   * **不报错、不阻塞**（本查询的失败刻意不进任何 `note`，也不显示任何错误文案）。
   * 查询键由 id 集合的函数（结构化哈希）决定，故即使每次传入新数组引用也不会重复请求。
   */
  const lastPortionsQuery = useQuery({
    queryKey: queryKeys.foodLastPortions(visibleFoodIds),
    queryFn: () =>
      api.get<LastPortionsResponse>('/foods/last-portions', { ids: visibleFoodIds.join(',') }),
    enabled: visibleFoodIds.length > 0,
  });

  /**
   * 常吃榜列表项：**名称 + 天数 + 一行「上次是 X 月 X 日」**，没有任何营养字段、
   * 没有 `role="meter"`（AC-11.5.3 / AC-11.5.4）。
   *
   * 点击行为与 `recent` / `favorite` **完全一致**：走既有 `chooseFood()` → 份量确认 → 确认记录
   * （跳过份量会让热量记录失真，这是硬红线）。
   *
   * UI 规范（`docs/VISUAL-SYSTEM.md`）：圆角用语义令牌 `rounded-control`，
   * 触控目标 `qsh-touch-target`（≥44×44），12px 文字用 `slate-600 / dark:slate-300`（§5 约束）。
   *
   * 日期行是**行内的一行小字**（与「搜索结果行」的 `renderFoodList` 同款排版）：
   * 它**不是**独立控件，故直接放进这个整行 `<button>` 里 —— 不新增嵌套 `<button>`
   * （嵌套 button 是非法 HTML，读屏会读乱，见 `renderFoodList` 注释）。
   *
   * ⚠️ **日期必须并进 `aria-label`**：`aria-label` 会**覆盖**按钮内的文本，读屏只念它。
   * 日期若只渲染在行内，读屏用户就听不到 —— 视觉与读屏信息不对等（NFR-7）。
   * 故这里是「一个控件一个 aria-label」：`topFoodsAria(..., lastLoggedMonthDay)`，
   * 而不是另挂一个 aria 属性让读屏念两遍。
   */
  const renderTopList = (items: readonly TopFoodItem[], days: number): ReactElement => (
    <ul className="mt-3 space-y-2">
      {items.map((item) => {
        // 行内小字与 aria **共用**这一份格式化结果（视觉 == 读屏，NFR-7）
        const lastLoggedMonthDay = topFoodLastLoggedMonthDay(item.lastLoggedDate);
        const lastLoggedLine = topFoodsLastLoggedLabel(lastLoggedMonthDay);
        return (
          <li key={item.foodItemId ?? item.name}>
            <button
              type="button"
              onClick={() => {
                if (item.food != null) {
                  chooseFood(item.food);
                }
              }}
              aria-label={topFoodsAria(item.name, item.dayCount, days, lastLoggedMonthDay)}
              className="qsh-touch-target flex w-full items-center justify-between gap-3 rounded-control px-4 py-3 text-left ring-1 ring-brand-100 transition hover:bg-brand-50 dark:ring-slate-700 dark:hover:bg-slate-700"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                  {item.name}
                </span>
                {lastLoggedLine !== '' && (
                  <span className="mt-0.5 block text-xs text-slate-600 dark:text-slate-300">
                    {lastLoggedLine}
                  </span>
                )}
              </span>
              <span className="qsh-tnum shrink-0 text-xs text-slate-600 dark:text-slate-300">
                {topFoodDaysLabel(item.dayCount)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  /**
   * 选中食物 → 进入份量确认。
   *
   * **D-1 上次份量记忆**：默认份量**优先用这个食物「上次记的份量」**（`meal_logs` 里最近一次
   * 有有效份量的记录，由 `GET /foods/last-portions` 预取）；没有历史（或离线取不到）→
   * **回落** `resolveDefaultServing(food)`，行为与从前**完全一致**。
   *
   * 取值口径（「哪条历史有效」+「怎么折成默认份量」）在 `@qsh/core` 单一真源。
   * 用户仍可在份量确认区直接改（这里只是**默认填值**，不锁死、也不跳过确认）。
   */
  const chooseFood = (food: FoodItem, source: 'search' | 'barcode' = 'search'): void => {
    // C-3 多选模式：点一行 = 加进待记清单（**不入库、不进份量确认**）。
    // 去重语义在 core（`addPendingItem`）：重复点同一样不产生第二行、也不重置已调份量。
    if (multiSelect) {
      addToPending(food);
      return;
    }
    const portion = lastPortionsQuery.data?.portions?.[String(food.id)] ?? null;
    const remembered = resolveLastPortionServing(portion, food);
    const serving = remembered ?? resolveDefaultServing(food);
    setSelected(food);
    setSelectedSource(source);
    setServingUnit(serving.unit);
    setGrams(String(serving.grams));
    setLastPortionGrams(remembered === null ? null : serving.grams);
  };

  /**
   * C-3 把一条食物加入待记清单。
   *
   * 默认份量与单条路径**同口径**（有历史先用上次记的量，否则食物库默认份量）——
   * 用户在清单里仍可逐项改（红线③：可逐项取消 / 可整体放弃）。
   */
  const addToPending = (food: FoodItem): void => {
    const portion = lastPortionsQuery.data?.portions?.[String(food.id)] ?? null;
    const remembered = resolveLastPortionServing(portion, food);
    const serving = remembered ?? resolveDefaultServing(food);
    setPendingItems((current) =>
      addPendingItem(current, {
        foodId: food.id,
        name: food.name,
        gramsText: String(serving.grams),
        servingUnit: serving.unit,
        kcalPer100g: food.kcalPer100g,
      }),
    );
  };

  /** 从待记清单移除一项（红线③：可逐项取消）。 */
  const removeFromPending = (foodId: number): void => {
    setPendingItems((current) => removePendingItem(current, foodId));
  };

  /** 改清单里某一项的克数文本（逐项调份量）。 */
  const changePendingGrams = (foodId: number, gramsText: string): void => {
    setPendingItems((current) => setPendingItemGramsText(current, foodId, gramsText));
  };

  /** 整体放弃清单（红线③）—— 清空后不发出任何写入请求。 */
  const discardPending = (): void => {
    setPendingItems([]);
  };

  /**
   * 一次确认 → 把整份清单写入（`onSubmit({ kind: 'batch' })`，父组件走单事务端点）。
   *
   * 校验先于提交：有份量没填对 → 一句中性提示，**不发请求**（避免「按钮能点、点了报错」）。
   */
  const submitBatch = async (): Promise<void> => {
    if (!isPendingListRecordable(pendingItems)) {
      setNote(COPY.pendingGramsInvalid);
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await onSubmit({ kind: 'batch', items: toBatchItems(pendingItems) });
    } finally {
      setBusy(false);
    }
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
   * C-4 第一步：把快加内容存进个人食物库（`POST /foods`）。
   *
   * ## 时序决策：**先记录，再存库**（方案甲），且**存库失败不视为记录失败**
   *
   * 两个请求的顺序与失败语义是本功能最关键的设计点，理由：
   * 1. **主操作优先**：用户点「确认记录」的第一目的是**把这一餐记下来**。记录先落库，
   *    存库是**增强**（让下次能搜到），增强不该阻塞主流程；
   * 2. **不产生孤儿数据**：若反序（先 `POST /foods` 再记录），一旦记录失败（校验 / 断网），
   *    食物库里就留下一条没人用过的条目 —— 孤儿。用户既没记成这一餐，库还脏了；
   * 3. **失败口径明确**：`onSubmit` 成功即表示记录已落库（父组件内部有自己的离线入队与
   *    乐观更新），此时若 `POST /foods` 失败，**只影响「下次能不能搜到」**，不影响这次
   *    记录的正确性 —— 故给一句软着陆提示，**绝不**回滚记录、绝不报「失败」。
   *
   * ## 为什么 `onSubmit` 抛错时**不**调 `POST /foods`
   *
   * `run()` 里 `onSubmit` 抛错会向上冒泡（父组件已给过提示）。此时记录**没**成功，
   * 若还去存库就正好制造了上面说的孤儿条目。故本函数在 `run` 成功返回后才执行。
   *
   * ## 请求体（严格对齐 `CreateCustomFoodRequest`）
   *
   * **不发送 `source` / `createdByUserId`** —— 契约里根本没有这两个字段，服务端也
   * 一律强制 `'user_custom'` + JWT 用户 id（安全边界在服务端，前端不参与、也参与不了）。
   *
   * `category` 显式发 `'other'`：用户手填的食物无从判断品类（「楼下麻辣烫」是什么分类
   * 只有用户知道），而 `/foods/categories` 返回的是**码点序**、会原样展示任何脏值 ——
   * 发一个猜出来的分类既不准、又可能引入脏值。归到 `other`（展示名「其他」）是诚实的降级。
   *
   * 宏量（蛋白 / 脂肪 / 碳水）**不发**：快加表单只有名称 + 热量，用户没填的字段
   * 不替用户编造（服务端默认落 0）。
   *
   * @returns 是否**成功**存进食物库（`false` = 记录成功但没存上，调用方按软着陆提示）
   */
  const saveQuickToLibrary = async (name: string, kcal: number): Promise<boolean> => {
    try {
      await api.post<FoodItem>('/foods', {
        name,
        category: 'other',
        kcalPer100g: kcal,
      });
      // 食物库新增了一条：让「最近 / 收藏 / 搜索 / 常吃榜」的缓存失效，下次进入即可见。
      await queryClient.invalidateQueries({ queryKey: ['foods'] });
      return true;
    } catch {
      // 存库是增强：失败只影响「下次能不能搜到」，绝不回滚记录、绝不指责用户。
      return false;
    }
  };

  /**
   * 提交快加（含「存进食物库」分支）。
   *
   * 顺序：① 记录（`onSubmit`）→ ② 若勾选则存库。②失败只给软着陆提示。
   * 成功提示**合并成一句**（避免连续两条 note 互相覆盖、用户看不到存库结果）。
   *
   * ⚠️ `onSubmit` 抛错时**只记录不存库**，且**不再向上抛** —— 调用点是
   * `void submitQuick(...)`（事件处理器不能 async 冒泡），若这里不 catch 就会变成
   * **未处理的 Promise 拒绝**（生产环境里是控制台噪音，测试里会被 vitest 捕获为
   * unhandled error）。记录失败的用户提示由父组件（`DiaryPage.handleSubmit`）
   * 负责 —— 它内部有完整的业务错误 / 断网分流，这里不重复提示、也不抢它的活。
   */
  const submitQuick = async (name: string, kcal: number): Promise<void> => {
    setBusy(true);
    setNote(null);
    let recorded = false;
    try {
      await onSubmit({ kind: 'quick', name, kcal });
      recorded = true;
    } catch {
      // 记录没成功：父组件已给出对应提示（业务错误 / 离线入队），此处静默即可。
      recorded = false;
    } finally {
      setBusy(false);
    }
    // 记录没成功 → 不存库（否则会留下一条没人用过的孤儿食物条目）。
    if (!recorded || !quickSaveToLibrary) {
      return;
    }
    const saved = await saveQuickToLibrary(name, kcal);
    setNote(saved ? COPY.quickSavedToLibrary : COPY.quickSaveToLibraryMissed);
  };

  /**
   * 食物列表（搜索 / 最近 / 收藏 / 分类共用）。
   *
   * 搜索结果里的 `qualifier`（区分词，如 `干` / `鲜蘑` / `香辣味`）以中性小标签展示：
   * 跨来源同物异名**不合并**，靠它让用户自己分辨「哪一条是我要的」——
   * 标签只是**事实陈述**（形态 / 口味 / 部位规格），不含任何好坏评价词。
   *
   * **每行右侧有两个独立控件**（R3.4 / GAP-1 收藏开关 + D-5 历史开关）：
   * 它们都是**行内独立控件**，与「选中该行食物」互不干扰 ——
   * - 用 `type="button"` + `e.stopPropagation()`：点它们**不会**冒泡去触发外层的
   *   选食物按钮（否则会误弹份量确认区，甚至误记一餐）；
   * - 用**同级** `<button>` 平级排布：让它们与「选食物」是 DOM 里的**兄弟**而非嵌套 ——
   *   嵌套 `<button>` 是非法 HTML，读屏会读乱。
   *   键盘可达性由每个真按钮自身保证（各自可 Tab 聚焦、Enter/Space 触发）。
   * - 星号带 `aria-pressed`（状态）与 `aria-label`（`收藏 X` / `取消收藏 X`）。
   * - 历史按钮带 `aria-expanded`（展开态）与 `aria-controls`（指向它控制的展开区）。
   *
   * ## D-5：历史面板挂在**每一行**（不只是常吃榜）
   *
   * 用户问「这道菜我上次什么时候吃的」的时刻，发生在**搜索结果 / 最近 / 收藏**里 ——
   * 他正盯着某一行，还没决定记不记。常吃榜有门槛（≥ 3 天）且只列前 12 条，覆盖不到
   * 这些时刻。故这里给**每一行**一个次级动作，三个 tab 共用同一处实现。
   *
   * 展开区（`FoodHistoryPanel`）渲染在 `<li>` **内部、两个按钮之外** ——
   * 它是 `<li>` 的子节点，与按钮们平级，**不在任何按钮内部**，
   * 故不构成「button 套 button」的非法结构。
   */
  const renderFoodList = (items: readonly FoodItem[]): ReactElement => (
    <ul className="mt-3 space-y-2">
      {items.map((food) => {
        const qualifier = 'qualifier' in food ? (food as FoodSearchHit).qualifier : null;
        const favorited = favoriteIds.has(food.id);
        const historyOpen = historyFoodId === food.id;
        return (
          <li
            key={food.id}
            className="rounded-xl ring-1 ring-brand-100 transition hover:bg-brand-50 dark:ring-slate-700 dark:hover:bg-slate-700"
          >
            <div className="flex items-stretch gap-1">
              <button
                type="button"
                onClick={() => chooseFood(food)}
                className="qsh-touch-target min-w-0 flex-1 rounded-l-xl px-4 py-3 text-left"
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
                  toggleHistory(food.id);
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
                disabled={favoriteMutation.isPending}
                onClick={(event) => {
                  // 星号是独立控件：绝不让这次点击冒泡去选中 / 记录这一行食物
                  event.stopPropagation();
                  toggleFavorite(food);
                }}
                className="qsh-touch-target shrink-0 rounded-r-xl px-3 text-lg leading-none disabled:opacity-60"
              >
                <span
                  aria-hidden="true"
                  className={favorited ? 'text-amber-400' : 'text-slate-300 dark:text-slate-500'}
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
                  onCollapse={() => toggleHistory(food.id)}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );

  /**
   * 记录面板的遮罩 + 容器。
   *
   * ## 为什么必须 `createPortal` 到 `document.body`（390×844 实测根因）
   *
   * `AppShell` 的 `<main>` 带 `animate-fade-in`，其 keyframes 含 `transform`。
   * CSS 规定：祖先只要有 `transform`（哪怕动画已停在 `translateY(0)`、`transform` 计算值
   * **不为 `none`**），就会成为 `position: fixed` 后代的**包含块**。于是这层
   * `fixed inset-0` 不再相对**视口**，而是相对 `<main>` 定位：
   *
   * - 改动前实测：`<main>` 顶边 `t=73`、高 `1156` → 遮罩 `t=93 h=1136`（视口只有 844）；
   * - 面板被 `items-end` 推到 `t=863 b=1229`，**完全落在折线以下**（`panelVisibleInViewport = 0`），
   *   顶部 93px 的原页面（含 sticky 顶栏）**未被遮罩覆盖** → 那里仍可点击，**点击穿透**；
   * - 浅色下遮罩把背景亮度压低 36.3%（勉强可见），深色下只压 17.9%（几乎看不出）。
   *
   * `createPortal` 把弹层挂到 `body`，脱离 `<main>` 的包含块，`fixed` 恢复「相对视口」，
   * 遮罩铺满、面板贴底、顶栏不可点。**这是根因修复，不是视觉微调。**
   *
   * ## 遮罩两套取值（按实测像素亮度定，不是凭感觉）
   *
   * 实测同区域平均亮度下降：浅色 `slate-900/50` 约 45%、深色 `slate-950/65` 约 55%。
   * 深色需要**更深**（`slate-950` + 更高不透明度）：深色底本身已经很暗，用浅色那套
   * `slate-900/40` 压下去几乎不产生「浮起」感。
   */
  const dialog = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`记录${MEAL_TYPE_LABELS[mealType]}`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 dark:bg-slate-950/65 sm:items-center sm:p-4"
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

        {/* 记录方式标签（「常吃」在数据不足时**整块隐藏**，AC-11.5.2）

            P0 窄屏裁切（390px 实测）：改动前 6 个 tab 合计 390px、容器净宽仅 350px
            （面板 `p-5` 左右各 20px），`scrollWidth 390 > clientWidth 350` → 末项「套餐」
            `right = 410`，被视口右缘切掉半个字。两处一起改：
            ① `px-4 → px-3`：单 tab 60px → 52px，6 项合计 342px ≤ 350px，**默认 6 项免横滑**；
            ② 容器补 `pr-2`：**「常吃」出现时是 7 项**（合计 400px，必然溢出），
               右侧留 8px 安全内边距，末项才能被完整横滑出来而不是贴着裁剪边缘。 */}
        <div
          role="tablist"
          aria-label="记录方式"
          className="mt-4 flex gap-1.5 overflow-x-auto pr-2"
        >
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
                'qsh-touch-target shrink-0 rounded-full px-3 text-sm transition',
                tab === item.key
                  ? 'bg-brand-600 text-white'
                  : 'bg-brand-50 text-slate-600 dark:bg-slate-900 dark:text-slate-300',
              ].join(' ')}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* C-3 多选模式开关（**正交于来源**：在任何渲染食物行的 tab 下都能开）。
            默认关闭 → 单条快速路径（G1 ≤3 次点击）逐字节不变。 */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={multiSelect}
              onChange={(event) => {
                const next = event.target.checked;
                setMultiSelect(next);
                // 关掉多选 = 退出多选状态：清空清单，避免「隐藏的清单」日后被意外写入
                if (!next) {
                  setPendingItems([]);
                }
                // 切到多选时收起单条的份量确认区，避免两套交互并存
                setSelected(null);
                setNote(null);
              }}
              className={CHECKBOX_CLASS}
              style={multiSelect ? CHECK_MARK_STYLE : undefined}
            />
            {COPY.multiSelectToggle}
          </label>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {multiSelect ? COPY.multiSelectHintOn : COPY.multiSelectHintOff}
          </span>
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
                                  {item.brand !== null ? `${item.brand} · ` : ''}每 100g {toDisplayEnergy(item.kcalPer100g, unit)} {energyLabel(unit)}
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

        {/* 分类浏览（A2 / R3.4）：两步 —— ① 点分类 chip ② 点食物（第 3 次点击是「确认记录」）。
            chip 顺序按 `FOOD_CATEGORIES` 重排（见 `orderedCategories`）：服务端返回的是码点序，
            `other` 会排首位，这里改为展示序（`other` 落末尾）。
            文字走 `foodCategoryLabel`（`other` → 「其他」）；emoji 仍按**原始枚举值**取
            （`emojiForCategory('other')` → 🍴），两者分工不要混 —— 排序/取 emoji 用枚举值，
            只有展示给人看的那一处用展示名。

            为什么用独立 tab 而不是搜索面板里的筛选：`searchQuery` 的 enabled 要求关键词非空，
            纯分类浏览放进搜索面板会被直接拦死；且现有 tab 都是「一种记录方式」，
            分类浏览正是其中一种（PRD §4.3 R3.4 把「搜索 / 分类浏览」并列）。 */}
        {tab === 'category' && (
          <div className="mt-4">
            {categoriesQuery.isLoading && <p className="text-xs text-slate-500 dark:text-slate-400">读取中…</p>}

            {orderedCategories.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label={COPY.foodCategoryTab}>
                {orderedCategories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    // 这是一组**筛选按钮**（同一时刻只选一个），不是 tablist —— 故用 aria-pressed
                    aria-pressed={selectedCategory === category}
                    // 读屏标签用**展示名**（与下面可见文字同一个词），不是原始枚举值
                    aria-label={foodCategoryAriaFor(foodCategoryLabel(category))}
                    onClick={() =>
                      setSelectedCategory((current) => (current === category ? null : category))
                    }
                    className={[
                      'qsh-touch-target shrink-0 rounded-full px-4 text-sm transition',
                      selectedCategory === category
                        ? 'bg-brand-600 text-white'
                        : 'bg-brand-50 text-slate-600 dark:bg-slate-900 dark:text-slate-300',
                    ].join(' ')}
                  >
                    <span aria-hidden="true" className="mr-1">
                      {/* `other` 走兜底 🍴（规则表里没有 'other' 关键词）——
                          它有兜底语义，正是我们要的表达，不需要额外补规则。
                          emoji 仍按**原始枚举值**取（`emojiForCategory('other')` → 🍴），
                          只有可见文字换成展示名。 */}
                      {emojiForCategory(category)}
                    </span>
                    {foodCategoryLabel(category)}
                  </button>
                ))}
              </div>
            )}

            {/* 还没选类别：只给一句中性引导，不留空卡、不预选任何一类。
                仅在**确实有分类可选**时才给这句 —— 否则会变成「一边说挑一个、
                一边一个都没有」的自相矛盾（分类列表为空走下面那条空态）。 */}
            {selectedCategory === null && orderedCategories.length > 0 && (
              <p className="mt-3 flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                <BrandDecor variant="bloom" className="h-4 w-4 shrink-0 text-brand-300" />
                {COPY.foodCategoryPrompt}
              </p>
            )}

            {/* **分类列表本身**为空（`/foods/categories` 成功但返回 `[]`）：给一个可行的下一步。
                interface 失败另走上面的 note（`foodCategoryLoadFailed`），与这里分工明确。 */}
            {categoriesQuery.isLoading === false && orderedCategories.length === 0 && (
              <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{COPY.foodCategoryListEmpty}</p>
            )}

            {/* 选中后：复用 `renderFoodList` —— 视觉与点击行为（份量确认 → 确认记录）
                与 搜索 / 最近 / 收藏 / 常吃 **完全一致**，不另写一套列表。 */}
            {selectedCategory !== null && categoryQuery.isFetching && categoryItems.length === 0 && (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">读取中…</p>
            )}
            {selectedCategory !== null && categoryItems.length > 0 && renderFoodList(categoryItems)}
            {categoryEmpty && (
              <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{COPY.foodCategoryEmpty}</p>
            )}

            {/* 完整性：把服务端 `total` 如实呈现 + 「加载更多」（与搜索同款呈现方式） */}
            {selectedCategory !== null && categoryItems.length > 0 && (
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  共 {categoryTotal} 条，已显示 {categoryItems.length} 条
                </span>
                {hasMoreCategory && (
                  <button
                    type="button"
                    onClick={() => void categoryQuery.fetchNextPage()}
                    disabled={categoryQuery.isFetchingNextPage}
                    className="qsh-touch-target shrink-0 rounded-full bg-brand-50 px-4 text-sm text-brand-700 disabled:opacity-60 dark:bg-brand-900/40 dark:text-brand-200"
                  >
                    {categoryQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
                  </button>
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
              // 防御：接口降级 / 契约不符时 `data` 可能不是数组 —— 当作「暂时没有」的空态，
              // 绝不把非数组喂给 `renderFoodList`（那会让整面板崩掉）。
              const items = Array.isArray(query.data) ? query.data : [];
              if (items.length === 0) {
                return (
                  <p className="flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                    <BrandDecor variant="bloom" className="h-4 w-4 shrink-0 text-brand-300" />
                    {tab === 'recent' ? COPY.favoriteEmptyRecent : COPY.favoriteEmpty}
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

            {/* D-2：快加的名称与今天这一餐已记过的自定义条目同名时，给同一句中性觉察
                （判定口径与「选中食物」同源，都走 `findSameMealItem`）。仍是不阻断。 */}
            {sameMealMatches.quick !== null && (
              <p
                data-testid="same-meal-hint-quick"
                className="text-xs text-slate-500 dark:text-slate-400"
              >
                {COPY.sameMealHint}
              </p>
            )}

            {/*
              C-4 第一步 · 「存进我的食物库」（勾选框，**默认不勾**）。

              存在的意义：快加的食物此前**下次搜不到、每次都要重填**。勾上后服务端会
              落一条 `source=user_custom` 的自定义食物，下次搜索直接命中、可复用。

              默认不勾的理由见 `quickSaveToLibrary` 的状态注释（食物的复利在重复吃的东西，
              一次性条目存了是噪音）。

              无障碍：`<label>` 包住 input 与文字（点文字也能勾），label 文字本身就是读屏
              标签，故不再加冗余 aria-label；额外用 `quickSaveToLibraryAria` 解释**后果**
              （会存成「其他」分类），让读屏用户得到与视觉用户等价的上下文。
            */}
            <label className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={quickSaveToLibrary}
                onChange={(event) => setQuickSaveToLibrary(event.target.checked)}
                aria-describedby="quick-save-to-library-hint"
                className={`mt-0.5 ${CHECKBOX_CLASS}`}
                style={quickSaveToLibrary ? CHECK_MARK_STYLE : undefined}
              />
              <span>
                <span className="block">{COPY.quickSaveToLibraryLabel}</span>
                <span
                  id="quick-save-to-library-hint"
                  className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400"
                >
                  {COPY.quickSaveToLibraryHint}
                </span>
              </span>
            </label>

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

        {/* 套餐模板（R3.9 / TC-26）。

            ⚠️ **空态文案（GAP-2 收口）**：本 tab 只能**应用**套餐，新建入口在 `/diary`
            各餐次的「存成套餐」（`SaveComboDialog`）。所以空态不能只说「还没有」——
            套餐现在已经建得出来了，只是**不在这块面板里建**；`COPY.comboEmpty` 明确
            指向 `/diary` 的那条去路，避免用户在本 tab 找不到入口而以为功能不存在。 */}
        {tab === 'combo' && (
          <div className="mt-4">
            {comboQuery.isLoading && <p className="text-xs text-slate-500 dark:text-slate-400">读取中…</p>}
            {(comboQuery.data ?? []).length === 0 && !comboQuery.isLoading && (
              <p className="text-sm text-slate-500 dark:text-slate-400">{COPY.comboEmpty}</p>
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
            {/* D-1：这次默认份量用了「上次记的量」时，给一句中性小字说明 ——
                不弹窗、不要求确认（不增加点击），也不做任何对比 / 评价。 */}
            {lastPortionGrams !== null && (
              <p
                data-testid="last-portion-hint"
                className="mt-1 text-xs text-slate-500 dark:text-slate-400"
              >
                {COPY.lastPortionHint(lastPortionGrams)}
              </p>
            )}
            {/* D-2：这一餐里可能已经记过同一样时，给一句**中性觉察** ——
                不是弹窗、不是红色、不需要确认、**不阻断提交**（默认放行）。
                用户无视它继续点「确认记录」照常成功。 */}
            {sameMealMatches.selected !== null && (
              <p
                data-testid="same-meal-hint"
                className="mt-1 text-xs text-slate-500 dark:text-slate-400"
              >
                {COPY.sameMealHint}
              </p>
            )}
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

        {/* C-3 待记清单（多选模式）：显示已加入项 + 每项可调份量 + 可逐项移除 + 可整体放弃。
            🔴 红线①：这里**不展示任何合计热量 / 超标提示**，不出现「合计 / 超出」等字样。 */}
        {multiSelect && pendingItems.length > 0 && (
          <section aria-label="待记清单" className="mt-5 rounded-2xl bg-brand-50 p-4 dark:bg-slate-900">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {COPY.pendingListTitle(pendingItems.length)}
              </h3>
              <button
                type="button"
                onClick={discardPending}
                className="qsh-touch-target rounded-lg px-3 text-sm text-slate-500 dark:text-slate-400"
              >
                {COPY.pendingListDiscard}
              </button>
            </div>
            <ul className="mt-2 space-y-2">
              {pendingItems.map((entry) => (
                <li
                  key={entry.foodId}
                  className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 dark:bg-slate-800"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-slate-100">
                    {entry.name}
                  </span>
                  <input
                    inputMode="decimal"
                    value={entry.gramsText}
                    onChange={(event) => changePendingGrams(entry.foodId, event.target.value)}
                    aria-label={COPY.pendingGramsAria(entry.name)}
                    className="qsh-tnum w-16 rounded-lg border border-brand-100 px-2 py-1 text-right text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <span className="text-xs text-slate-500 dark:text-slate-400">g</span>
                  <button
                    type="button"
                    aria-label={COPY.pendingListRemoveAria(entry.name)}
                    onClick={() => removeFromPending(entry.foodId)}
                    className="qsh-touch-target shrink-0 rounded-lg px-2 text-sm text-slate-500 dark:text-slate-400"
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
            {/* D-2：清单里任意一项在今天这一餐已经记过 → 同一句中性觉察。
                🔴 仍然**不阻断**「记录这 N 样」：用户可以直接提交（默认放行）。 */}
            {sameMealMatches.pending && (
              <p
                data-testid="same-meal-hint-batch"
                className="mt-2 text-xs text-slate-500 dark:text-slate-400"
              >
                {COPY.sameMealHint}
              </p>
            )}
          </section>
        )}

        {/* 确认按钮 */}
        <div className="mt-5 flex gap-2">
          {multiSelect ? (
            pendingItems.length > 0 ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void submitBatch()}
                className="qsh-touch-target flex-1 rounded-xl bg-brand-600 py-3 font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
              >
                {busy ? '正在记录…' : COPY.pendingConfirm(pendingItems.length)}
              </button>
            ) : (
              <p className="flex-1 text-center text-xs text-slate-500 dark:text-slate-400">
                {COPY.pendingListEmpty}
              </p>
            )
          ) : tab === 'quick' || selected !== null ? (
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
                  // C-4 第一步：走 `submitQuick` —— 记录成功后，若勾了「存进食物库」再落一条自定义食物。
                  void submitQuick(quickName.trim(), kcalValue);
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

  // 挂到 body：脱离 <main> 的 transform 包含块，`fixed inset-0` 才真的相对视口（详见 dialog 注释）
  return createPortal(dialog, document.body);
}
