import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateMealLogRequest,
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
import { api, isNetworkError, noticeFromError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { CACHE_KEYS, cacheGet, cacheSet } from '@/lib/local-cache';
import { addDays, formatDateLabel, formatMonthDay, todayKey } from '@/lib/format';
import { normalizeTrendResponse } from '@/lib/trend';
import { energyLabel, toDisplayEnergy, useUnitStore } from '@/lib/units';
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

export default function DiaryPage({ initialDate }: DiaryPageProps): ReactElement {
  const unit = useUnitStore((state) => state.unit);
  const queryClient = useQueryClient();
  const [date, setDate] = useState<string>(() => initialDate ?? todayKey());
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
            className="ml-1.5 rounded-lg border border-brand-100 px-2 py-1 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>
        {!isToday && (
          <button
            type="button"
            onClick={() => setDate(todayKey())}
            className="qsh-touch-target rounded-lg px-3 text-sm font-medium text-brand-700 ring-1 ring-brand-100 dark:text-brand-300 dark:ring-slate-700"
          >
            回到今天
          </button>
        )}
      </div>

      <div className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700">
        <p className="text-sm text-slate-500 dark:text-slate-400">{isToday ? '今天一共' : '这天一共'}</p>
        <p className="qsh-tnum mt-1 text-3xl font-bold text-brand-700 dark:text-brand-300">
          {toDisplayEnergy(todayTotal, unit)}
          <span className="ml-1.5 text-sm font-medium text-slate-500 dark:text-slate-400">
            {energyLabel(unit)}
          </span>
        </p>
        {/* B5：预算**未就绪时不渲染这一段**（加载中不留 0，也不 0 ↔ 真实值闪烁） */}
        {dailyBudget !== null && (
          <div className="mt-3" data-testid="daily-budget">
            <div className="h-2 w-full overflow-hidden rounded-full bg-brand-100 dark:bg-slate-700">
              <div
                className="h-full rounded-full bg-brand-500 transition-all"
                style={{ width: `${Math.min(progressRatio, 1) * 100}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              参考预算 {toDisplayEnergy(dailyBudget, unit)} {energyLabel(unit)}
              {progressRatio > 1 && isToday ? ' · 今天吃得丰富一些，明天照常就好' : ''}
            </p>
          </div>
        )}
      </div>

      {/* 一日档案（N2）：这一天的体重。
          有记录就展示；没有给一句中性提示 —— 不留空档，也不催你去称。 */}
      <div className="qsh-surface rounded-2xl p-4 dark:bg-slate-800 dark:ring-slate-700">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">这一天的体重</h2>
        {weightOfDay === null ? (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            这天没有称体重的记录。想补的话去「变化」页加一条就好。
          </p>
        ) : (
          <p className="qsh-tnum mt-1 text-2xl font-bold text-slate-800 dark:text-slate-100">
            {weightOfDay.weightKg.toFixed(1)}
            <span className="ml-1 text-sm font-medium text-slate-500 dark:text-slate-400">kg</span>
          </p>
        )}
      </div>

      {/* 拖拽引导（R3.8）：**首次进入显示一次**，可关闭。
          纯渲染层 + 本地一个布尔偏好，不注册任何定时器 / 后台任务。 */}
      {!guideDismissed && !isEmptyDay && (
        <div
          role="note"
          data-testid="reorder-guide"
          className="flex items-center justify-between gap-3 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
        >
          <span>{COPY.reorderGuide}</span>
          <button
            type="button"
            onClick={() => {
              dismissGuide();
              setGuideDismissed(true);
            }}
            aria-label={COPY.reorderGuideAriaClose}
            className="qsh-touch-target shrink-0 rounded-lg px-2 text-xs text-brand-700 dark:text-brand-200"
          >
            知道了
          </button>
        </div>
      )}

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
        // B5：预算未就绪（`null`）→ 整段不出现；拿到值才显示「/ 参考 N kcal」
        const budget = dailyBudget === null ? null : mealBudget(dailyBudget, group.mealType);
        return (
          <section
            key={group.mealType}
            ref={reorder.setZoneRef(group.mealType)}
            data-meal-type={group.mealType}
            aria-label={MEAL_TYPE_LABELS[group.mealType]}
            className={[
              'qsh-surface rounded-2xl p-5 transition dark:bg-slate-800 dark:ring-slate-700',
              // 落区高亮：环色需 ≥3:1（WCAG 1.4.11）—— 白底用 brand-500（3.34:1）、深底用 brand-400（6.42:1）
              reorder.targetMealType === group.mealType ? 'ring-2 ring-brand-500 dark:ring-brand-400' : '',
            ].join(' ')}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
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
              <ul className="mt-3 space-y-2">
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
                className="qsh-touch-target mt-3 w-full rounded-xl py-2.5 text-sm font-medium text-slate-600 ring-1 ring-brand-100 transition duration-qsh-base ease-qsh-out hover:bg-brand-50 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-700"
              >
                {COPY.comboSaveEntry}
              </button>
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
