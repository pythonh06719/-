import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateMealLogRequest,
  CreateMealsBatchRequest,
  CreateMealsBatchResponse,
  DashboardResponse,
  ListMealsResponse,
  MealComboRequest,
  MealComboWithItems,
  MealGroup,
  MealLog,
  MealType,
  Paginated,
  ReorderMealsRequest,
  ReorderMealsResponse,
  WeightLog,
  WeightTrendResponse,
} from '@qsh/shared-types';
import { applyReorder } from '@qsh/core';
import type { MealItemIdentity } from '@qsh/core';
import { api, isNetworkError, noticeFromError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { CACHE_KEYS, cacheGet, cacheSet } from '@/lib/local-cache';
import { addDays, formatDateLabel, formatMonthDay, isDateKey, todayKey } from '@/lib/format';
import { normalizeTrendResponse } from '@/lib/trend';
import { energyLabel, formatWeightNumber, toDisplayEnergy, useUnitStore, weightLabel } from '@/lib/units';
import {
  COPY,
  comboDefaultName,
  comboSaveDoneLine,
  mealMovedLine,
  portionKcalUpdatedLine,
  portionUpdatedLine,
} from '@/lib/copy';
import EmptyState from '@/components/common/EmptyState';
import { MEAL_BUDGET_SHARE, type ThemeBudget } from '@/theme/tokens';
import MealComposer from './MealComposer';
import type { ComposerSubmit } from './MealComposer';
import MealItemRow from './MealItemRow';
import MealPortionEditor from './MealPortionEditor';
import type { PortionEditSubmit } from './MealPortionEditor';
import SaveComboDialog from './SaveComboDialog';
import { usePointerReorder } from './usePointerReorder';
import { mealLogsToComboItems } from '@/lib/combo-map';
import { resolveMealLogName } from '@/lib/meal-name';
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

/**
 * 解析首屏日期（C-1 接入：从「足迹日历」点格跳来时带 `?date=YYYY-MM-DD`）。
 *
 * 优先级：URL `?date=`（合法）> 外部注入 `initialDate` > 今天。
 * 非法 / 缺失的 query 一律回退 —— 绝不把脏参数当日期用（脏值会静默变成别的日子）。
 */
function resolveInitialDate(injected: string | undefined, fromQuery: string | null): string {
  if (fromQuery !== null && isDateKey(fromQuery)) {
    return fromQuery;
  }
  return injected ?? todayKey();
}

/** 每餐参考预算 = 每日预算 × 餐次占比。 */
function mealBudget(dailyBudget: number, mealType: keyof typeof MEAL_BUDGET_SHARE): number {
  const share = MEAL_BUDGET_SHARE[mealType];
  return Math.round(dailyBudget * share);
}

/**
 * 从本地缓存读取每日预算（**仅作离线兜底**，不再是唯一来源 —— B5）。
 *
 * @returns 缓存里的建议摄入 kcal；无缓存 / 值非法时返回 `0`（调用方按「未就绪」处理）。
 */
function readDailyBudget(): number {
  const budget = cacheGet<ThemeBudget>(CACHE_KEYS.localBudget);
  return budget === null || !Number.isFinite(budget.intakeRecommended) ? 0 : budget.intakeRecommended;
}

/**
 * 每餐参考预算的**取值来源**（B5 · R3.8）：服务端权威 `/dashboard` 的预算。
 *
 * 改动的起因：原先只从本地缓存取，清缓存 / 换设备 / 首次进入时缓存为空 →
 * 分母为 0 → 整段「/ 参考 N kcal」**不渲染也不报错**，用户以为产品没这个功能。
 *
 * 现在的顺序：
 *   ① `/dashboard` 的 `budget.intakeRecommended`（服务端按用户资料重算，唯一权威）；
 *   ② 服务端还没回来时用本地缓存顶上（离线/弱网仍可用，且不会 0 ↔ 真实值闪烁）；
 *   ③ 都没有 → `null` = **未就绪**，整段不渲染（绝不显示 0）。
 *
 * ⚠️ **0 一律表示「不知道」，不表示「预算是 0」**：加载中就把这一段留白，加载完再出现。
 */
function resolveDailyBudget(serverBudget: DashboardResponse['budget']): number | null {
  if (
    serverBudget !== null &&
    serverBudget !== undefined &&
    Number.isFinite(serverBudget.intakeRecommended) &&
    serverBudget.intakeRecommended > 0
  ) {
    return serverBudget.intakeRecommended;
  }
  const cached = readDailyBudget();
  return cached > 0 ? cached : null;
}

/**
 * 拖拽引导条的「仅一次」本机键（Q-7）。
 *
 * 复用 `lib/plateau-visibility.ts` 的本地持久化思路（纯 UI 偏好，非用户数据），
 * **刻意不用 `qsh:cache:*` 前缀** —— 避免被 `cacheClearAll()` 顺带清掉。
 */
const REORDER_GUIDE_KEY = 'mealReorderGuideDismissed';

function readGuideDismissed(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(REORDER_GUIDE_KEY) === '1';
  } catch {
    return false;
  }
}

function dismissGuide(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(REORDER_GUIDE_KEY, '1');
  } catch {
    // 隐私模式 / 容量超限：不影响主流程
  }
}

/**
 * 把 `applyReorder`（`@qsh/core`）算出的映射套回分组结构。
 *
 * ⚠️ 前端乐观更新**必须**与服务端用同一个纯函数，否则两端的顺序会漂移（K13 / NFR-11）。
 */
function applyMapping(
  groups: readonly MealGroup[],
  mapping: ReadonlyMap<number, { mealType: MealType; sortOrder: number }>,
): MealGroup[] {
  const all = groups.flatMap((group) => group.logs);
  const buckets = new Map<MealType, MealLog[]>();
  for (const log of all) {
    const next = mapping.get(log.id);
    const mealType = next?.mealType ?? log.mealType;
    const sortOrder = next?.sortOrder ?? log.sortOrder;
    const bucket = buckets.get(mealType);
    const entry = { ...log, mealType, sortOrder };
    if (bucket === undefined) {
      buckets.set(mealType, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  return MEAL_TYPE_ORDER.map((mealType) => {
    const logs = (buckets.get(mealType) ?? [])
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);
    return { mealType, logs, totalKcal: sumKcal(logs) };
  });
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

/**
 * 本页新增的文案 —— **刻意放在文件局部常量**，本轮不改 `lib/copy.ts`。
 *
 * 语气沿用 PRD §7：只陈述当前发生了什么 + 给一条同屏可达的出路，
 * 不用「失败 / 错误 / 崩溃」这类词，不含任何数字（NFR-11），也不用红 / 警示色。
 */
/** 「还在取」—— 首次进入且本机没有任何旧记录时的占位。 */
const DIARY_MEALS_LOADING = '正在取出这一天的记录…';
/** 「取不到」—— 请求没通且本机也没有旧记录时的占位（详见 JSX 处的三分支注释）。 */
const DIARY_MEALS_LOAD_ERROR = '这一天的记录暂时取不到，稍后再看看就好';

/**
 * 报表族的**前缀**查询键（`['report']`）：周报、阶段回顾、记录足迹日历都在这段前缀下。
 *
 * 为什么从 `queryKeys` 的工厂**取首段**而不是手写 `['report']`：
 * `weeklyReport` / `periodReport` / `reportCalendar` 三个键都以同一段前缀开头，
 * 取工厂产物的第一段即可命中全部 —— 将来 `lib/queryClient.ts` 改键名，这里会跟着改，
 * 不会悄悄失配（失效漏掉表现为「别的页面数字不更新」，用户无从归因）。
 * 传占位入参是必要的：这三个工厂都要求日期 / 月份参数，而前缀本身与参数无关。
 */
const REPORT_KEY_PREFIX: readonly string[] = queryKeys.reportCalendar('').slice(0, 1);
/** 食物族的前缀查询键（`['foods']`）：常吃榜 / 上次份量 / 食用历史都在这段前缀下。 */
const FOODS_KEY_PREFIX: readonly string[] = queryKeys.foodRecent.slice(0, 1);

export default function DiaryPage({ initialDate }: DiaryPageProps): ReactElement {
  const unit = useUnitStore((state) => state.unit);
  /** 全局体重单位（D-3）：一日档案里的体重按此换算展示（存储仍为 kg）。 */
  const weightUnit = useUnitStore((state) => state.weightUnit);
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [date, setDate] = useState<string>(() => resolveInitialDate(initialDate, searchParams.get('date')));
  const [composerMeal, setComposerMeal] = useState<MealGroup['mealType'] | null>(null);
  const [announcement, setAnnouncement] = useState<string>('');
  const [notice, setNotice] = useState<string | null>(null);
  /** 拖拽引导条（首次进入、可关闭，仅一次）。 */
  const [guideDismissed, setGuideDismissed] = useState<boolean>(() => readGuideDismissed());
  /** 正在改份量的记录（B3；`null` = 面板未打开）。 */
  const [editingLog, setEditingLog] = useState<MealLog | null>(null);
  /** 正在「存成套餐」的餐次（GAP-2；`null` = 命名弹窗未打开）。 */
  const [savingComboMeal, setSavingComboMeal] = useState<MealGroup['mealType'] | null>(null);
  /** 存套餐失败 / 离线时就地提示（`null` = 不展示；409 同名走服务端文案）。 */
  const [comboError, setComboError] = useState<string | null>(null);

  const mealsQuery = useQuery({
    queryKey: queryKeys.meals(date),
    queryFn: () => api.get<ListMealsResponse>('/meals', { date }),
  });

  useEffect(() => {
    if (mealsQuery.data !== undefined) {
      cacheSet(CACHE_KEYS.meals(date), mealsQuery.data);
    }
  }, [mealsQuery.data, date]);

  // 一日档案（N2）：把这一天的体重一并展示。
  // 只拉一次全量趋势（交给 react-query 缓存），再按当前日期匹配 —— 切日期不会重复请求。
  const weightsQuery = useQuery({
    queryKey: queryKeys.weightTrend,
    queryFn: () => api.get<WeightTrendResponse | Paginated<WeightLog>>('/weights', { limit: 200 }),
  });

  /** 当前查看日的体重记录（没有则为 null，页面给中性提示而不是留空）。 */
  const weightOfDay = useMemo(() => {
    if (weightsQuery.data === undefined) return null;
    return normalizeTrendResponse(weightsQuery.data).find((point) => point.date === date) ?? null;
  }, [weightsQuery.data, date]);

  /**
   * 是否正在查看今天 —— 决定「今天一共 / 这天一共」这类措辞。
   * （修掉一个既有误导：翻到历史某一天时，卡片仍写着「今天一共」。）
   */
  const isToday = date === todayKey();

  const groups = useMemo(
    () => normalizeGroups(mealsQuery.data ?? cacheGet<ListMealsResponse>(CACHE_KEYS.meals(date)) ?? undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mealsQuery.data, date],
  );

  /**
   * 「现在看到的是上次同步的记录」—— 请求失败且**确实有旧记录在展示**时才为真。
   *
   * 为什么这是功能性缺陷而非体验细节（数据可信 G2）：本页的**每一个热量数字**都由 `groups` 推出 ——
   * 顶部「今天一共」、四个餐次各自的合计、以及「参考预算」那条进度条的分子。而 `groups` 有两条
   * **静默**退路（与体重页 `allPoints` 同形）：
   *   ① `mealsQuery.data === undefined` → 退到本机 `CACHE_KEYS.meals(date)`；
   *   ② react-query 的内存副本（`gcTime` 30min）→ 上次成功的结果被原样保留，
   *      后台 refetch 失败只把 `isError` 置真、**不动 `data`。
   * 两条路都让「几小时前的记录」和「刚同步的记录」长得一模一样，而用户拿它决定还吃不吃。
   *
   * 为什么只认 `isNetworkError`：业务错误（如 500）不该被说成「网络不稳定」——
   * 那会让用户去查 WiFi，而问题在服务端。**归因不准比不提示更糟**。
   *
   * 为什么还要 `hasAnyLog`：没有旧记录时页面本就没有数字（只有空状态），
   * 这时挂一条「这些是上次同步的数据」是在指控一个不存在的展示。
   *
   * ⚠️ 与 `AppShell` 的 `OfflineSyncBanner` **不是同一件事，不重复**：
   * 横幅的判据是 `navigator.onLine` + 离线队列条数，说的是「网络状态 / 有几笔待送出去」；
   * 本条的判据是**这一次请求的成败**，说的是「你正在看的这些数字是旧的」。
   * 「请求打不通但 `navigator.onLine === true`」（服务端 502、代理挂了、DNS 慢、
   * 中间设备断电）时横幅整块不渲染，而本页已经静默降级 —— 那正是本条唯一存在的场景。
   */
  const hasAnyLog = groups.some((group) => group.logs.length > 0);
  const showingStaleMeals =
    mealsQuery.isError && isNetworkError(mealsQuery.error) && hasAnyLog;

  /**
   * 「还在取」与「取不到」—— 两个此前**完全缺失**的中间态（P0 状态混淆）。
   *
   * 修复前，`groups` 为空时无条件渲染 `COPY.emptyTodayDiary`（「今天还没记，从一顿早餐开始也行」）。
   * 而 `groups` 为空有两种截然不同的成因，页面把它们画成了同一句话：
   *   ① **请求还没回来**（首次进入 / 弱网）：此时「今天还没记」是一个**尚未知道**的结论；
   *   ② **请求失败且本机没有旧记录**（新用户、刚清缓存、换设备）：
   *      此时「今天还没记」更糟 —— 它把「没能读出来」说成「你还没记」，
   *      用户如果今天确实记过，会以为记录丢了（一个不存在的损失）。
   * 只有 ③ 请求成功且当天真的没有记录，才是那句话成立的场景。
   *
   * 两个判据都要求 `!hasAnyLog`：一旦屏幕上有记录可看，就该走 `showingStaleMeals`
   * 那条「这些是上次同步时的数据」—— 有东西可展示时不说「取不到」。
   */
  const mealsLoadingEmpty = mealsQuery.isLoading && !hasAnyLog;
  const mealsFailedEmpty = mealsQuery.isError && !hasAnyLog;

  /**
   * D-2「重复记录温和提示」的数据来源：**这一天的全部记录**（最小投影）。
   *
   * 交给 `MealComposer` 后由 `@qsh/core` 的 `findSameMealItem` 按「同一天 + 同一餐」过滤，
   * 故这里**不需要**预先按餐次切分 —— 传全天，让判定只有一份实现，也让父组件保持简单。
   *
   * 只投影判定真正用到的四个字段（`MealLog` 字段远多于这些），避免把整行记录传进面板。
   */
  const existingMealItems = useMemo(
    (): MealItemIdentity[] =>
      groups.flatMap((group) =>
        group.logs.map((log) => ({
          loggedDate: log.loggedDate,
          mealType: log.mealType,
          foodItemId: log.foodItemId,
          customName: log.customName,
        })),
      ),
    [groups],
  );

  /**
   * 每餐参考预算的分母（B5）：**服务端权威**。
   *
   * 预算来自用户资料 + 目标，与「正在看哪一天」无关，故固定查**今天**的看板
   * （键稳定 → 翻日期不会重复发请求，且与 `DashboardPage` 共用同一份 react-query 缓存）。
   */
  const budgetQuery = useQuery({
    queryKey: queryKeys.dashboard(todayKey()),
    queryFn: () => api.get<DashboardResponse>('/dashboard', { date: todayKey() }),
    retry: 0,
  });

  /** 拿到服务端预算后回写本地缓存：仅用于离线兜底，不再当作唯一来源。 */
  useEffect(() => {
    const budget = budgetQuery.data?.budget;
    if (budget !== undefined && budget !== null && Number.isFinite(budget.intakeRecommended)) {
      cacheSet<ThemeBudget>(CACHE_KEYS.localBudget, {
        intakeRecommended: budget.intakeRecommended,
        bmr: budget.bmr,
        tdee: budget.tdee,
      });
    }
  }, [budgetQuery.data]);

  /** `null` = 尚未拿到预算（**不显示**这一段，绝不渲染 0）。 */
  const dailyBudget = useMemo<number | null>(
    () => resolveDailyBudget(budgetQuery.data?.budget ?? null),
    [budgetQuery.data],
  );

  /**
   * 「预算分母是上次同步的」—— 与 `showingStaleMeals` **刻意分成两条**，不合并。
   *
   * ### 为什么必须分开（这是本条存在的理由，不是排版偏好）
   *
   * 两处降级来自**两个互不相干的请求**（`/meals` 与 `/dashboard`），且各自的失效时刻不同：
   * 用户在地铁里打开本页，可能 `/meals` 通了而 `/dashboard` 没通（不同后端实例 / 缓存策略）。
   * 合并成一条的后果是**指代不明**：用户看到「这些是上次同步的数据」却不知道是
   * 「我今天吃了多少」旧了，还是「我能吃多少」这个分母旧了 —— 而后者恰恰是
   * 「还吃不吃」的决策依据，说不清等于没说。
   *
   * ### 这一处还有一个**文档落差**要一并补上
   *
   * `/why-numbers:292` 写着「每日建议摄入取自服务端按你的资料重算的结果（**本机缓存只在断网时兜底**）」，
   * 即文档向用户承诺了「兜底存在、且只在断网时发生」。但页面从未在兜底发生时告知 ——
   * 承诺了机制却没给触发信号。本条就是那个信号：只在**真的走了缓存**时才出现，
   * 与文档措辞对齐（网络层失败才兜底；服务端正常返回预算时不出现）。
   *
   * ### 「有没有预算数字」这一关为什么**不在**判据里
   *
   * `resolveDailyBudget()` 三条退路全空时返回 `null`，此时 `daily-budget` 整块不渲染，
   * 而本标记就**嵌在那块内部**（见 JSX）—— 「没有数字就不指控」这件事由渲染位置保证。
   * 刻意不在判据里再写一遍 `dailyBudget !== null`：那是同一条约束的第二份拷贝，
   * 改一处忘另一处就会漂移，而且它永远与渲染位置同真同假，**任何用例都区分不出来**
   * （写测试时实测过：撤掉它，10 条用例仍全绿 —— 即那条断言其实没在守任何东西）。
   *
   * ⚠️ 若日后把这段标记挪出 `daily-budget` 块，**必须**把这一关补回判据，
   * 否则会在「屏幕上根本没有预算」时凭空指控。
   *
   * ### 为什么判据里**不必**再区分「兜底」与「内存副本」
   *
   * 本条只认「这一次 `/dashboard` 请求在网络层失败了」。走到失败态时屏幕上的预算
   * 只可能有两个来源，**两个都是旧的**：① `budgetQuery.data === undefined` →
   * `readDailyBudget()` 读本机缓存（`:118`）；② react-query 的内存副本（`gcTime` 30min）
   * → 上次成功的响应被原样保留，refetch 失败只置 `isError`、**不动 `data`**。
   * 所以「这一次请求在网络层失败」已经完整覆盖了两条退路，再去分辨来源只是徒增分支。
   *
   * 🔴 不含任何数字（NFR-11）；不用红/警示色（coral 在本项目语义偏「提醒」，
   * 这里只是「数据来源说明」）；不弹窗、不遮挡、不禁用任何操作。
   */
  const showingStaleBudget = budgetQuery.isError && isNetworkError(budgetQuery.error);

  const todayTotal = useMemo(
    () => groups.reduce((total, group) => total + group.totalKcal, 0),
    [groups],
  );

  /**
   * 记录侧所有写操作共用的一次「失效广播」。
   *
   * **本页六处调用点**（删一条 / 排序 / 批量记 / 单条记 / 套餐饮用 / 改份量）全部走这里 ——
   * 新增失效键只需要改这一处，不会出现「记餐刷新了、删餐没刷新」的口径漂移。
   *
   * 为什么要失效这四族键（P1 派生统计口径）：
   * - `meals(date)` / `dashboard(date)`：本页本身的数字；
   * - `['report']`：周报摄入、阶段回顾（多样食物数 / 记录天数 / 记录条数）、记录足迹日历，
   *   都是按同一批餐次记录的**服务端聚合**，链路里看不到「刚刚多了一条」；
   * - `['foods']`：常吃榜（`foodTop`）、上次份量（`foodLastPortions`）、食用历史（`foodHistory`）
   *   同理 —— 它们的输入是「某段时间的全部记录」，而不是本页传出去的那一条。
   * 少了这两族的表现：记完一餐去周报 / 回顾 / 足迹日历 / 搜索面板的「常吃」tab，
   * 看到的还是记之前的旧值，要手动刷新才对得上。
   *
   * ⚠️ 只失效**前缀**：报表与食物族的键都带日期 / 月份 / id 等参数，逐个枚举迟早会漏
   * （每新增一个统计入口就要回来补一行），而漏掉的那一处正是用户看不出来、只会觉得
   * 「数字好像不太对」的地方。前缀失效对调用方更省事：这里不需要知道具体有哪些键。
   */
  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.meals(date) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(date) });
    await queryClient.invalidateQueries({ queryKey: REPORT_KEY_PREFIX });
    await queryClient.invalidateQueries({ queryKey: FOODS_KEY_PREFIX });
  };

  const remove = useMutation({
    mutationFn: (id: number) => api.delete<{ id: number }>(`/meals/${id}`),
    onSuccess: async () => {
      setAnnouncement('已删除这条记录');
      await invalidate();
    },
    onError: () => setNotice('暂时没能删除这条记录，稍后再试一次就好'),
  });

  /**
   * 把「这一餐」存成套餐（R3.9 / GAP-2）—— `POST /meal-combos`。
   *
   * 关键点（架构设计 §2.3）：
   * - **不做乐观更新**：新建的 `id` 由服务端生成，乐观插入只能造个假 id，且这是低频动作；
   * - **成功后 `invalidateQueries(queryKeys.combos)`**：`MealComposer` 的套餐 tab 用的是同一个 key，
   *   不刷新的话用户切过去看不到刚存的套餐；
   * - **不入离线队列**（Q-3）：同名 409 会永久堵死离线队列（P0-5 同类陷阱）——
   *   离线时给**诚实告知**（`COPY.comboSaveOffline`），明确没保存、联网再来，**不假装成功**；
   * - 409 同名 / 400 走服务端温和文案（`noticeFromError` 透出 message），**弹窗不关**，用户改名重试。
   */
  const saveCombo = useMutation({
    mutationFn: (body: MealComboRequest) => api.post<MealComboWithItems>('/meal-combos', body),
    onSuccess: async (combo) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.combos });
      setSavingComboMeal(null);
      setComboError(null);
      setNotice(null);
      setAnnouncement(comboSaveDoneLine(combo.name));
    },
    onError: (error) => {
      // 网络层错误：诚实告知「没保存」，**不入队**
      if (isNetworkError(error)) {
        setComboError(COPY.comboSaveOffline);
        return;
      }
      // 业务错误（409 同名 / 400 校验）：透出服务端文案，弹窗保留让用户改名重试
      setComboError(noticeFromError(error, COPY.comboSaveFailed));
    },
  });

  /**
   * 提交一次排序 / 跨餐移动（R3.8 / AC-3.8.9）。
   *
   * 流程：**乐观更新 → PATCH → 成功 invalidate / 失败或离线入队 + 回滚 + 中性提示**。
   * 乐观更新用 `@qsh/core` 的 `applyReorder`，与服务端同一个纯函数（K13）。
   *
   * ⚠️ 失败提示必须是中性陈述（「这次没有移动成功，稍后再试试」）：
   * 不以「失败」作标题、不用红色警示语义（PRD §7）。
   */
  const commitReorder = async (orderedIds: number[], mealType: MealType): Promise<void> => {
    const before = groups;
    const items = before.flatMap((group) =>
      group.logs.map((log) => ({ id: log.id, mealType: log.mealType, sortOrder: log.sortOrder })),
    );
    const next = applyReorder(items, mealType, orderedIds, { compact: true });
    const mapping = new Map(next.map((row) => [row.id, { mealType: row.mealType, sortOrder: row.sortOrder }]));

    const optimistic: ListMealsResponse = {
      date,
      groups: applyMapping(before, mapping),
      totalKcal: 0,
    };
    optimistic.totalKcal = optimistic.groups.reduce((total, group) => total + group.totalKcal, 0);

    // ① 乐观更新（立即重排）
    cacheSet(CACHE_KEYS.meals(date), optimistic);
    queryClient.setQueryData(queryKeys.meals(date), optimistic);
    setNotice(null);

    const body: ReorderMealsRequest = { loggedDate: date, mealType, orderedIds };
    try {
      // ② 提交；成功后以**服务端顺序**为准（K13）
      await api.patch<ReorderMealsResponse>('/meals/reorder', body);
      setAnnouncement(mealMovedLine(MEAL_TYPE_LABELS[mealType]));
      await invalidate();
    } catch (error) {
      // ③ 无论哪种失败都要回滚乐观更新（先回到提交前的顺序）
      const rollback: ListMealsResponse = {
        date,
        groups: before as MealGroup[],
        totalKcal: before.reduce((total, group) => total + group.totalKcal, 0),
      };
      cacheSet(CACHE_KEYS.meals(date), rollback);
      queryClient.setQueryData(queryKeys.meals(date), rollback);

      if (isNetworkError(error)) {
        // 真离线：入队待联网重放 + 中性提示
        await enqueueRequest({ path: '/meals/reorder', method: 'PATCH', body });
        setNotice(COPY.reorderFailed);
      } else {
        // 业务错误（如记录已被删除 / 已不在这一天）：**不入队** —— 重放只会一直失败，
        // 反而变成「毒消息」。直接按服务端文案给中性提示，让用户刷新后重试。
        setNotice(noticeFromError(error, COPY.reorderFailed));
      }
    }
  };

  /** 本餐内当前顺序（供上移 / 下移 / 拖拽计算完整期望顺序）。 */
  const idsOf = (mealType: MealType): number[] =>
    (groups.find((group) => group.mealType === mealType)?.logs ?? []).map((log) => log.id);

  /** 上移：与本餐前一条交换 → 提交本餐完整顺序。 */
  const handleMoveUp = (id: number): void => {
    const mealType = groups.find((group) => group.logs.some((log) => log.id === id))?.mealType;
    if (mealType === undefined) return;
    const ids = idsOf(mealType);
    const index = ids.indexOf(id);
    if (index <= 0) return;
    const nextIds = [...ids];
    const prev = nextIds[index - 1];
    if (prev === undefined) return;
    nextIds[index - 1] = id;
    nextIds[index] = prev;
    void commitReorder(nextIds, mealType);
  };

  /** 下移：与本餐后一条交换 → 提交本餐完整顺序。 */
  const handleMoveDown = (id: number): void => {
    const mealType = groups.find((group) => group.logs.some((log) => log.id === id))?.mealType;
    if (mealType === undefined) return;
    const ids = idsOf(mealType);
    const index = ids.indexOf(id);
    if (index < 0 || index >= ids.length - 1) return;
    const nextIds = [...ids];
    const next = nextIds[index + 1];
    if (next === undefined) return;
    nextIds[index + 1] = id;
    nextIds[index] = next;
    void commitReorder(nextIds, mealType);
  };

  /** 移动到某餐：**追加到目标餐末尾**（Q-1：简单、可预期，不做「智能插位」）。 */
  const handleMoveTo = (id: number, target: MealType): void => {
    void commitReorder([...idsOf(target), id], target);
  };

  // 手写 Pointer Events 拖拽（**可选增强**：不挂载时降级控件照常工作）
  const reorder = usePointerReorder<MealType>({
    groups: groups.map((group) => ({ mealType: group.mealType, ids: group.logs.map((log) => log.id) })),
    onCommit: (orderedIds, mealType) => void commitReorder(orderedIds, mealType),
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

    /**
     * C-3 一餐多品项**批量记录**：把整份待记清单一次性写入（单事务端点 `POST /meals/batch`）。
     *
     * - **一次请求**（不是 N 次单条）：服务端在**同一事务**里写入，避免「写一半失败」；
     *   各条 `sortOrder` 由服务端分配、**互不相同**；
     * - 离线：整批入离线队列（重放时仍是一次原子写入），并**逐条**本地乐观插入，
     *   `sortOrder` 依次递增（与服务端口径一致）；
     * - 🔴 无负罪感：这里**不计算、不展示、不播报任何合计 / 超标**内容（红线①）。
     */
    if (payload.kind === 'batch') {
      const body: CreateMealsBatchRequest = {
        loggedDate: date,
        mealType,
        items: payload.items.map((item) => ({
          foodId: item.foodId,
          grams: item.grams,
          servingUnit: item.servingUnit,
          source: 'search',
        })),
      };
      const count = payload.items.length;
      try {
        await api.post<CreateMealsBatchResponse>('/meals/batch', body);
        setComposerMeal(null);
        setNotice(null);
        setAnnouncement(`${MEAL_TYPE_LABELS[mealType]}已记录 ${count} 样`);
        await invalidate();
      } catch (error) {
        if (isNetworkError(error)) {
          await enqueueRequest({ path: '/meals/batch', method: 'POST', body });
          // 本地乐观：按清单顺序依次插入（sortOrder 递增，与服务端「下一个下标 + index」同口径）
          let localMax = (groups.find((group) => group.mealType === mealType)?.logs ?? []).reduce(
            (max, log) => Math.max(max, log.sortOrder),
            -1,
          );
          for (const item of payload.items) {
            localMax += 1;
            applyOptimistic(mealType, {
              id: Date.now() + localMax,
              userId: 0,
              loggedDate: date,
              mealType,
              foodItemId: item.foodId,
              customName: null,
              foodName: item.name,
              grams: item.grams,
              servingUnit: item.servingUnit,
              servingQty: null,
              kcal: item.kcal,
              proteinG: null,
              fatG: null,
              carbG: null,
              fiberG: null,
              sodiumMg: null,
              source: 'search',
              comboId: null,
              note: null,
              sortOrder: localMax,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          setComposerMeal(null);
          setNotice(COPY.offlineQueued);
          setAnnouncement(`${MEAL_TYPE_LABELS[mealType]}已记录 ${count} 样`);
          return;
        }
        // 业务错误（如某条食物已不可见）：不入队、保留面板，给中性提示让用户处理。
        setNotice(noticeFromError(error, COPY.batchFailed));
      }
      return;
    }

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
      } catch (error) {
        if (isNetworkError(error)) {
          // 真离线：入队待联网重放 + 立即反馈
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
        // 业务错误（如套餐已被删除）：不入队、不关面板，给中性提示让用户自行处理。
        setNotice(noticeFromError(error, '这个套餐这次没能记录，稍后再试一次就好'));
        return;
      }
    }

    try {
      await api.post<MealLog>('/meals', request);
      setComposerMeal(null);
      setNotice(null);
      setAnnouncement(`${MEAL_TYPE_LABELS[mealType]}已记录，约 ${toDisplayEnergy(kcal, unit)} ${energyLabel(unit)}`);
      await invalidate();
    } catch (error) {
      if (isNetworkError(error)) {
        // 离线：入队 + 本地乐观更新，界面立即反馈（不阻塞用户）
        await enqueueRequest({
          path: '/meals',
          method: 'POST',
          body: request,
        });
        // AC-3.8.5：本地乐观条目也按「本餐当前最大值 + 1」排在最后
        // （服务端是唯一权威，这里只是让离线时的展示顺序与上线后一致）。
        const localMax = (groups.find((group) => group.mealType === mealType)?.logs ?? []).reduce(
          (max, log) => Math.max(max, log.sortOrder),
          -1,
        );
        applyOptimistic(mealType, {
          id: Date.now(),
          userId: 0,
          loggedDate: date,
          mealType,
          foodItemId: payload.kind === 'food' ? payload.food.id : null,
          customName: payload.kind === 'quick' ? payload.name : null,
          // 离线乐观条目也带上派生名：否则离线期间列表会短暂退化成「食物 #id」，
          // 联网后（服务端 join 补名）又变回真名 —— 同一屏出现两种名字。
          foodName: payload.kind === 'food' ? payload.food.name : null,
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
          sortOrder: localMax + 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        setComposerMeal(null);
        setNotice(COPY.offlineQueued);
        setAnnouncement(`${MEAL_TYPE_LABELS[mealType]}已记录，约 ${toDisplayEnergy(kcal, unit)} ${energyLabel(unit)}`);
        return;
      }
      // 业务错误（如校验未通过 / 日期不合法）：**不入队**、不做本地乐观插入
      // （服务端已明确拒绝，乐观插入会显示一条根本存不下的记录）。保留面板让用户修正。
      setNotice(noticeFromError(error, '这条记录这次没能加上，看看提示再试一次就好'));
    }
  };

  /**
   * 改份量 / 改热量的本地乐观更新（离线重放前先把这条改过来，界面立即生效）。
   *
   * ⚠️ 只改 `kcal` / `grams` 两个展示字段，**顺序与其它记录一律不动** ——
   * 改份量不该牵动排列，否则用户会以为记录被重新排过。
   */
  const applyPortionOptimistic = (id: number, patch: { kcal: number; grams: number | null }): void => {
    const cached =
      cacheGet<ListMealsResponse>(CACHE_KEYS.meals(date)) ??
      ({ date, groups: [], totalKcal: 0 } as ListMealsResponse);
    const nextGroups = MEAL_TYPE_ORDER.map((type) => {
      const existing = cached.groups.find((group) => group.mealType === type);
      const logs = (existing?.logs ?? []).map((log) => (log.id === id ? { ...log, ...patch } : log));
      return { mealType: type, logs, totalKcal: sumKcal(logs) };
    });
    const next: ListMealsResponse = {
      date,
      groups: nextGroups,
      totalKcal: nextGroups.reduce((total, group) => total + group.totalKcal, 0),
    };
    cacheSet(CACHE_KEYS.meals(date), next);
    queryClient.setQueryData(queryKeys.meals(date), next);
  };

  /**
   * 提交一次改份量（B3）：`PATCH /api/meals/:id`。
   *
   * - **食物库条目只发份量**，热量由服务端按食物库重算（与「重新搜一次再记」同一个公式）；
   * - **快速加卡条目发热量**（它没有食物库参照物）。
   *
   * 🔴 **无负罪感硬约束**：这里**不计算、不展示、不播报任何「超出预算 / 超标」内容** ——
   * 改份量只是把记错的数字改对，用户不该因此收到一条评价（PRD §7）。
   */
  const handlePortionEdit = async (payload: PortionEditSubmit): Promise<void> => {
    if (editingLog === null) {
      return;
    }
    const id = editingLog.id;
    const isLibrary = editingLog.foodItemId !== null;
    const line = isLibrary ? portionUpdatedLine(payload.name) : portionKcalUpdatedLine(payload.name);
    const path = `/meals/${id}`;

    try {
      await api.patch<{ entry: MealLog }>(path, payload.body);
      setEditingLog(null);
      setNotice(null);
      setAnnouncement(line);
      await invalidate();
    } catch (error) {
      if (isNetworkError(error)) {
        await enqueueRequest({ path, method: 'PATCH', body: payload.body });
        applyPortionOptimistic(id, { kcal: payload.kcalPreview, grams: payload.grams });
        setEditingLog(null);
        setNotice(COPY.offlineQueued);
        setAnnouncement(line);
        return;
      }
      setNotice(noticeFromError(error, '这条这次没能改，稍后再试一次就好'));
    }
  };

  const progressRatio = dailyBudget !== null && dailyBudget > 0 ? todayTotal / dailyBudget : 0;

  /** 整日都没有记录时，给一个生活化的空状态（大 emoji + 一句话）。 */
  const isEmptyDay = groups.every((group) => group.logs.length === 0);

  return (
    <section aria-labelledby="diary-title" className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 id="diary-title" className="text-title font-semibold text-slate-900 dark:text-slate-100">
          饮食记录
        </h1>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setDate((current) => addDays(current, -1))}
            className="qsh-touch-target rounded-control px-3 text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
            aria-label="前一天"
          >
            ‹
          </button>
          <span className="px-2 text-sm text-slate-600 dark:text-slate-300">{formatDateLabel(date)}</span>
          <button
            type="button"
            onClick={() => setDate((current) => addDays(current, 1))}
            className="qsh-touch-target rounded-control px-3 text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
            aria-label="后一天"
          >
            ›
          </button>
        </div>
      </div>

      {/* 一日档案（N2）：直接翻到任意一天。
          原先只能靠 ‹ › 逐日翻 —— 想看三个月前的某一天要点几十次，实际上等于看不了。
          用原生 `<input type="date">`，不引第三方日历库；上限设为今天（未来没有记录）。 */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-slate-600 dark:text-slate-300" htmlFor="diary-date">
          翻到
          <input
            id="diary-date"
            type="date"
            value={date}
            max={todayKey()}
            onChange={(event) => {
              const next = event.target.value;
              if (next !== '') setDate(next);
            }}
            className="ml-1.5 rounded-control border border-brand-100 px-2 py-1 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>
        {!isToday && (
          <button
            type="button"
            onClick={() => setDate(todayKey())}
            className="qsh-touch-target rounded-control px-3 text-sm font-medium text-brand-700 ring-1 ring-brand-100 dark:text-brand-300 dark:ring-slate-700"
          >
            回到今天
          </button>
        )}
      </div>

      {/*
        「这些记录是上次同步时的」标记（数据可信度G2 · 与体重页 `weight-stale-notice` 同形）。

        位置在「今天一共」卡**之上**：这张卡与下面四个餐次卡的数字全部由同一份 `groups` 推出，
        提示放在数字之前才读得通「接下来这些数字都是旧的」。

        ⚠️ 刻意**不含相对时间**（「3 分钟前的记录」）：那是 NFR-11 意义上的新数字，需要
        `/why-numbers` 有条目才能上屏，且它随秒跳动、盯着看时自己变反而更不可信。
        语气与配色：中性陈述（灰），**不用红、不用警示色** ——coral 在本项目语义偏「提醒」，
        这里只是「数据来源说明」。不弹窗、不遮挡、不禁用任何操作（记录流程照常可用）。
        出路同屏可达：`重新试试` 直接重跑本查询，成功后本条自动消失。
      */}
      {showingStaleMeals && (
        <div
          role="status"
          aria-live="polite"
          data-testid="diary-stale-meals-notice"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card bg-slate-100 px-4 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        >
          <span>{COPY.staleDataNotice}</span>
          <button
            type="button"
            onClick={() => {
              void mealsQuery.refetch();
            }}
            disabled={mealsQuery.isFetching}
            className="qsh-touch-target rounded-control px-2 py-1 font-medium text-brand-700 underline underline-offset-2 disabled:opacity-60 dark:text-brand-300"
          >
            {mealsQuery.isFetching ? COPY.staleDataRetrying : COPY.staleDataRetry}
          </button>
        </div>
      )}

      <div className="qsh-surface p-5">
        <p className="text-sm text-slate-500 dark:text-slate-400">{isToday ? '今天一共' : '这天一共'}</p>
        <p className="qsh-tnum mt-tight text-display font-bold text-brand-700 dark:text-brand-300">
          {toDisplayEnergy(todayTotal, unit)}
          <span className="ml-1.5 text-sm font-medium text-slate-500 dark:text-slate-400">
            {energyLabel(unit)}
          </span>
        </p>
        {/* B5：预算**未就绪时不渲染这一段**（加载中不留 0，也不 0 ↔ 真实值闪烁） */}
        {dailyBudget !== null && (
          <div className="mt-block" data-testid="daily-budget">
            <div className="h-2 w-full overflow-hidden rounded-pill bg-brand-100 dark:bg-slate-700">
              <div
                className="h-full rounded-pill bg-brand-500 transition-all"
                style={{ width: `${Math.min(progressRatio, 1) * 100}%` }}
              />
            </div>
            <p className="mt-tight text-xs text-slate-500 dark:text-slate-400">
              参考预算 {toDisplayEnergy(dailyBudget, unit)} {energyLabel(unit)}
              {progressRatio > 1 && isToday ? ' · 今天吃得丰富一些，明天照常就好' : ''}
            </p>
            {/*
              「预算分母是上次同步时的」标记 —— **刻意与上方记录那条分开**（理由见
              `showingStaleBudget` 的注释：两个请求各自失效，合并会让指代不明）。

              位置在 `daily-budget` 块**内部**：这一条说的是「进度条 + 参考预算」这两个元素，
              放在块外就丢了指代对象。四条餐次卡后面的「/ 参考 N」由同一个 `dailyBudget`
              推出，故不必在每张餐次卡上再挂一遍（那会在同屏出现四条同句提示）。

              文案不引用 `COPY.staleDataNotice`（那句的「这些」在嵌套语境里指代不清），
              且「参考预算和进度条」点明了所指 —— 见 `COPY.staleBudgetNotice` 的注释。
            */}
            {showingStaleBudget && (
              <div
                role="status"
                aria-live="polite"
                data-testid="diary-stale-budget-notice"
                className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control bg-slate-100 px-3 py-1.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                <span>{COPY.staleBudgetNotice}</span>
                <button
                  type="button"
                  onClick={() => {
                    void budgetQuery.refetch();
                  }}
                  disabled={budgetQuery.isFetching}
                  className="qsh-touch-target rounded-control px-2 py-1 font-medium text-brand-700 underline underline-offset-2 disabled:opacity-60 dark:text-brand-300"
                >
                  {budgetQuery.isFetching ? COPY.staleDataRetrying : COPY.staleDataRetry}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 一日档案（N2）：这一天的体重。
          有记录就展示；没有给一句中性提示 —— 不留空档，也不催你去称。 */}
      <div className="qsh-surface p-5">
        <h2 className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">这一天的体重</h2>
        {weightOfDay === null ? (
          <p className="mt-tight text-sm text-slate-500 dark:text-slate-400">
            这天没有称体重的记录。想补的话去「变化」页加一条就好。
          </p>
        ) : (
          <p className="qsh-tnum mt-tight text-2xl font-bold text-slate-800 dark:text-slate-100">
            {formatWeightNumber(weightOfDay.weightKg, weightUnit)}
            <span className="ml-1 text-sm font-medium text-slate-500 dark:text-slate-400">{weightLabel(weightUnit)}</span>
          </p>
        )}
      </div>

      {/* 拖拽引导（R3.8）：**首次进入显示一次**，可关闭。
          纯渲染层 + 本地一个布尔偏好，不注册任何定时器 / 后台任务。 */}
      {!guideDismissed && !isEmptyDay && (
        <div
          role="note"
          data-testid="reorder-guide"
          className="flex items-center justify-between gap-3 rounded-card bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
        >
          <span>{COPY.reorderGuide}</span>
          <button
            type="button"
            onClick={() => {
              dismissGuide();
              setGuideDismissed(true);
            }}
            aria-label={COPY.reorderGuideAriaClose}
            className="qsh-touch-target shrink-0 rounded-control px-2 text-xs text-brand-700 dark:text-brand-200"
          >
            知道了
          </button>
        </div>
      )}

      {/*
        整日为空时的三分支：**正在取 / 取不到 / 真的没记**（见 `mealsLoadingEmpty` 处注释）。

        三者在此**互斥且穷尽**，`hasAnyLog` 为真时这里整块不渲染 —— 有记录可看的降级场景
        由上方 `diary-stale-meals-notice` 负责，两条路不重叠、也不互相替代。

        为什么**不复用**页内 `notice` 当错误出口：那块是**动作反馈槽**（记录成功 / 删除未成），
        把「本次拉取没成功」塞进去会让两种语义混在一条文案里 —— 用户分不清
        「刚才那笔没存上」和「这一页没读出来」，而两者的下一步完全不同。

        配色与文案：中性灰底 + 品牌色动作（`diary-stale-meals-notice` 同一样式），
        不用红 / 警示色；文案不含任何数字（NFR-11），出路**同屏可达**。
      */}
      {mealsLoadingEmpty ? (
        <p
          role="status"
          data-testid="diary-meals-loading"
          className="rounded-card bg-slate-100 px-4 py-3 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        >
          {DIARY_MEALS_LOADING}
        </p>
      ) : mealsFailedEmpty ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="diary-meals-error"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card bg-slate-100 px-4 py-3 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        >
          <span>{DIARY_MEALS_LOAD_ERROR}</span>
          <button
            type="button"
            onClick={() => {
              void mealsQuery.refetch();
            }}
            disabled={mealsQuery.isFetching}
            data-testid="diary-meals-retry"
            className="qsh-touch-target rounded-control px-2 py-1 font-medium text-brand-700 underline underline-offset-2 disabled:opacity-60 dark:text-brand-300"
          >
            {mealsQuery.isFetching ? COPY.staleDataRetrying : COPY.staleDataRetry}
          </button>
        </div>
      ) : isEmptyDay ? (
        <EmptyState title={COPY.emptyTodayDiary} />
      ) : null}

      {/* 屏幕阅读器播报记录结果（TC-48） */}
      <p className="qsh-sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {notice !== null && (
        <p role="status" className="rounded-card bg-brand-50 px-4 py-2 text-sm text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          {notice}
        </p>
      )}

      {groups.map((group) => {
        // B5：预算未就绪（`null`）→ 整段不出现；拿到值才显示「/ 参考 N kcal」
        const budget = dailyBudget === null ? null : mealBudget(dailyBudget, group.mealType);
        return (
          <section
            key={group.mealType}
            ref={reorder.setZoneRef(group.mealType)}
            data-meal-type={group.mealType}
            aria-label={MEAL_TYPE_LABELS[group.mealType]}
            className={[
              'qsh-surface p-5 transition duration-qsh-fast ease-qsh-out',
              // 落区高亮：必须用卡面的状态修饰符，不能写 ring 工具类 —— `.qsh-surface`
              // 会盖掉任何 ring 的颜色与宽度（详见 styles/index.css 里 `.qsh-surface-drop` 的注释）。
              // 环色 ≥3:1（WCAG 1.4.11）：白底 brand-500 3.34:1、深底 brand-400 6.42:1。
              reorder.targetMealType === group.mealType ? 'qsh-surface-drop' : '',
            ].join(' ')}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">
                {MEAL_TYPE_LABELS[group.mealType]}
              </h2>
              <p className="qsh-tnum text-xs text-slate-500 dark:text-slate-400">
                {toDisplayEnergy(group.totalKcal, unit)}
                {budget !== null ? ` / 参考 ${toDisplayEnergy(budget, unit)}` : ''} {energyLabel(unit)}
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
              <ul className="mt-block space-y-2">
                {group.logs.map((log, index) => (
                  <MealItemRow
                    key={log.id}
                    log={log}
                    name={resolveMealLogName(log)}
                    kcalLabel={`${toDisplayEnergy(log.kcal, unit)} ${energyLabel(unit)}`}
                    gramsLabel={log.grams !== null ? `${log.grams}g` : null}
                    canMoveUp={index > 0}
                    canMoveDown={index < group.logs.length - 1}
                    otherMeals={MEAL_TYPE_ORDER.filter((type) => type !== group.mealType).map((type) => ({
                      mealType: type,
                      label: MEAL_TYPE_LABELS[type],
                    }))}
                    onRemove={(id) => {
                      if (typeof id === 'number' && id > 0) {
                        remove.mutate(id);
                      }
                    }}
                    onMoveUp={handleMoveUp}
                    onMoveDown={handleMoveDown}
                    onMoveTo={handleMoveTo}
                    onEdit={(log) => setEditingLog(log)}
                    onDragHandlePointerDown={reorder.startDrag}
                    dragging={reorder.draggingId === log.id}
                    itemRef={reorder.setItemRef(log.id)}
                  />
                ))}
              </ul>
            )}

            {/* 存成套餐（GAP-2）：**仅本餐有条目时出现** —— 空餐存出去是一个
                「一键添加后什么都没记」的僵尸套餐，所以入口干脆不出现。 */}
            {group.logs.length > 0 && (
              <button
                type="button"
                data-testid={`save-combo-${group.mealType}`}
                onClick={() => {
                  setComboError(null);
                  setSavingComboMeal(group.mealType);
                }}
                className="qsh-touch-target mt-block w-full rounded-control py-2.5 text-sm font-medium text-slate-600 ring-1 ring-brand-100 transition duration-qsh-base ease-qsh-out hover:bg-brand-50 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-700"
              >
                {COPY.comboSaveEntry}
              </button>
            )}

            <button
              type="button"
              onClick={() => setComposerMeal(group.mealType)}
              className="qsh-touch-target mt-block w-full rounded-control bg-brand-50 py-2.5 text-sm font-medium text-brand-700 transition duration-qsh-base ease-qsh-out hover:bg-brand-100 dark:bg-brand-900/40 dark:text-brand-200"
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
          existingMealItems={existingMealItems}
          onClose={() => setComposerMeal(null)}
          onSubmit={handleSubmit}
        />
      )}

      {editingLog !== null && (
        <MealPortionEditor
          log={editingLog}
          onCancel={() => setEditingLog(null)}
          onSubmit={handlePortionEdit}
        />
      )}

      {savingComboMeal !== null && (
        <SaveComboDialog
          mealType={savingComboMeal}
          itemNames={(groups.find((group) => group.mealType === savingComboMeal)?.logs ?? []).map(
            (log) => resolveMealLogName(log),
          )}
          defaultName={comboDefaultName(MEAL_TYPE_LABELS[savingComboMeal], formatMonthDay(date))}
          busy={saveCombo.isPending}
          errorText={comboError}
          onCancel={() => {
            setSavingComboMeal(null);
            setComboError(null);
          }}
          onSubmit={(name) => {
            const logsOfMeal = groups.find((group) => group.mealType === savingComboMeal)?.logs ?? [];
            const body: MealComboRequest = {
              name,
              mealType: savingComboMeal,
              items: mealLogsToComboItems(logsOfMeal),
            };
            saveCombo.mutate(body);
          }}
        />
      )}
    </section>
  );
}
