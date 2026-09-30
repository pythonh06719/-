import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OnboardingResponse } from '@qsh/shared-types';
import { MET_ACTIVITY_LIBRARY, calcExerciseKcal } from '@qsh/core';
import { api, isNetworkError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth.store';
import { queryKeys } from '@/lib/queryClient';
import { CACHE_KEYS, cacheGet, cacheSet } from '@/lib/local-cache';
import { todayKey } from '@/lib/format';
import { COPY, exerciseDeleteAria } from '@/lib/copy';
import { energyLabel, toDisplayEnergy, useUnitStore } from '@/lib/units';
import { enqueueRequest } from '@/pwa/offline-queue';
import { WATER_QUICK_ADD_ML } from '@/theme/tokens';
import BrandDecor from '@/components/common/BrandDecor';

/**
 * 运动与饮水（`/exercise`，PRD §6 第 5 行 / R6.1~R6.3，二期）。
 *
 * - MET 表来自 `@qsh/core`（前后端同一真源），消耗 = MET × 体重 × 时长（服务端按档案体重计算）
 * - 饮水：一键 +250ml、可撤销上一条；在线走服务端，离线回退本地缓存（与看板共用同一缓存键）
 * - 后端未就绪时优雅降级，不白屏（T04 DoD）
 * - **PWA 快捷方式直达（C-2）**：桌面快捷方式「喝一杯水」打开的 `?focus=water` → 落地即记一杯
 *   （详见下方 `waterShortcut` 相关注释）
 */

interface WaterDay {
  date: string;
  totalMl: number;
  goalMl: number;
  logs: Array<{ id: number; amountMl: number }>;
}

interface ExerciseDay {
  date: string;
  logs: Array<{ id: number; activityName: string; minutes: number; kcalBurned: number }>;
  totalKcal: number;
}

interface WaterState {
  totalMl: number;
  history: number[];
}

const EMPTY_WATER: WaterState = { totalMl: 0, history: [] };

/**
 * 档案体重拿不到时的兜底估算体重（kg）。
 *
 * 与服务端 `ExerciseService.currentWeight()` 的**终端兜底**一致（`?? 60`）：
 * 正常情况下预览用的是档案里的真实体重（见下方 `previewWeightKg`），
 * 只有在读不到档案时才会退到这里 —— 与服务端此刻的口径也一致，不会出现「预览一个数、落库另一个数」。
 */
const FALLBACK_WEIGHT_KG = 60;

/** 与看板共用同一本地缓存键（离线兜底的一致性来源）。 */
function readLocalWater(date: string): WaterState {
  return cacheGet<WaterState>(`qsh:cache:water:${date}`) ?? EMPTY_WATER;
}

/**
 * 运动记录的删除会改变**两个汇总**，必须一并失效，否则用户删完切到报表会看到旧数字：
 * - `GET /report/weekly`（周报每日 `exerciseKcal` + `totalExerciseKcal`）；
 * - `GET /report/period`（阶段回顾的 `exercise: { sessions, totalMinutes }`）。
 *
 * 两者的查询键都带 `endDate`（period 还带 `days`），调用点无从得知用户此前看的是哪一天 ——
 * 故用 **`['report']` 前缀匹配**一次性覆盖所有档位 / 所有 endDate 的缓存
 * （React Query 的 `invalidateQueries` 默认按查询键前缀做部分匹配）。
 */
function reportQueryFilter(): { queryKey: readonly string[] } {
  return { queryKey: ['report'] };
}

export default function ExercisePage(): ReactElement {
  const queryClient = useQueryClient();
  const today = todayKey();
  const [activityCode, setActivityCode] = useState<string>('walking_brisk');
  const [minutes, setMinutes] = useState<number>(30);
  const [feedback, setFeedback] = useState<string>('');
  /** PWA 快捷方式直达提示（与运动反馈分开：运动反馈会被「记下这次运动」覆盖，这里不会被误清）。 */
  const [shortcutNotice, setShortcutNotice] = useState<string>('');
  const [searchParams, setSearchParams] = useSearchParams();

  const activity = MET_ACTIVITY_LIBRARY.find((item) => item.code === activityCode) ?? MET_ACTIVITY_LIBRARY[0]!;
  const unit = useUnitStore((state) => state.unit);

  /**
   * 档案体重（供本地即时预估用真实值，避免「预览按 60kg、落库按档案体重」两个数字）。
   *
   * - 数据源：`GET /profile` 的 `goal.startWeightKg` —— **正是服务端 `currentWeight()`
   *   优先采用的那个字段**（`user_goals.start_weight_kg` 随每次记体重联动更新），
   *   故此处算出的预览与「记下这次运动」后服务端返回的 `kcalBurned` 同源同值。
   * - 未登录时不发请求（`enabled`）：避免 401 触发全局登出（同 `WhyNumbersPage` 的收口做法）。
   * - 公式仍走 `@qsh/core` 的 `calcExerciseKcal`（前后端同一真源），这里只把**体重入参**换成真实值，
   *   不重写任何计算口径。
   */
  const profileQuery = useQuery({
    queryKey: queryKeys.profile,
    queryFn: () => api.get<OnboardingResponse>('/profile'),
    enabled: getAccessToken() !== null,
    retry: 0,
  });
  const profileWeightKg = profileQuery.data?.goal?.startWeightKg;
  const previewWeightKg =
    typeof profileWeightKg === 'number' && profileWeightKg > 0 ? profileWeightKg : FALLBACK_WEIGHT_KG;

  /** 本地即时预估（与服务端公式一致：MET × 体重 × 时长；体重取档案真实值，读不到时同服务端兜底 60） */
  const previewKcal = useMemo(
    () => calcExerciseKcal(activity.met, previewWeightKg, minutes),
    [activity, minutes, previewWeightKg],
  );

  const dayQuery = useQuery({
    queryKey: queryKeys.exerciseDay(today),
    queryFn: () => api.get<ExerciseDay>('/exercises', { date: today }),
    retry: 0,
  });

  const waterQuery = useQuery({
    queryKey: queryKeys.waterDay(today),
    queryFn: () => api.get<WaterDay>('/water', { date: today }),
    retry: 0,
  });

  const localWater = readLocalWater(today);

  const logExercise = useMutation({
    mutationFn: () => api.post<ExerciseDay>('/exercises', { activityCode, minutes, loggedDate: today }),
    onSuccess: (day) => {
      void queryClient.setQueryData(queryKeys.exerciseDay(today), day);
      setFeedback(COPY.movementLogged);
    },
    onError: (error: unknown) => {
      setFeedback(isNetworkError(error) ? '暂时连不上服务，运动先自己记着，恢复后会同步' : '刚才没记上，再试一次就好');
    },
  });

  /**
   * 从当日缓存里移掉一条运动记录，并**同步重算 `totalKcal`**。
   *
   * ⚠️ 这是本页最容易出错的地方：`GET /exercises` 的响应是
   * `{ date, logs, totalKcal }` —— 列表与合计是**同一份响应里的两个字段**。
   * 若只 `filter` 掉 `logs` 而保留旧 `totalKcal`，UI 会出现
   * 「下面只剩 1 条、上面的合计还按 2 条算」的**自相矛盾**。
   * 因此这里用**剩余的 logs 重新求和**（与后端 `listByDate` 同一口径：
   * 逐条 `kcalBurned` 求和后保留 1 位小数），而不是拿旧合计去减 —— 减法的浮点
   * 误差会让数字对不上后端下次返回的值。
   */
  const removeLogFromCache = (id: number): void => {
    queryClient.setQueryData<ExerciseDay>(queryKeys.exerciseDay(today), (previous) => {
      if (previous === undefined) {
        return previous;
      }
      const logs = previous.logs.filter((log) => log.id !== id);
      const totalKcal = Math.round(logs.reduce((sum, log) => sum + log.kcalBurned, 0) * 10) / 10;
      return { ...previous, logs, totalKcal };
    });
  };

  const deleteExercise = useMutation({
    mutationFn: (id: number) => api.delete<{ deleted: true }>(`/exercises/${id}`),
    onSuccess: (_data, id) => {
      // 先改本地缓存（列表 + 合计一起改），再失效涉及该日的两个汇总（周报 / 阶段回顾）
      removeLogFromCache(id);
      setFeedback(COPY.exerciseDeleted);
      void queryClient.invalidateQueries(reportQueryFilter());
    },
    onError: (error: unknown, id: number) => {
      if (isNetworkError(error)) {
        // 离线删除：入队 + 本地先移除（无二次确认，与 WinLogCard 的 DELETE 惯例一致）
        void enqueueRequest({ path: `/exercises/${id}`, method: 'DELETE' });
        removeLogFromCache(id);
        setFeedback(COPY.exerciseDeleted);
        return;
      }
      // 业务错误（如记录已被删 / 不存在）：中性陈述，不用「失败 / 错误」（PRD §7）
      setFeedback(COPY.exerciseDeleteMissed);
    },
  });

  const addWater = useMutation({
    mutationFn: () => api.post<WaterDay>('/water', { loggedDate: today }),
    onSuccess: (day) => void queryClient.setQueryData(queryKeys.waterDay(today), day),
    // 分流（照抄同页 `logExercise` / `deleteExercise` 的既有写法）：
    // - 网络错误 → 静默（`addWaterLocal` 已先把本地缓存 +250，联网后再同步，原意图）；
    // - 业务错误 → 中性提示。此前无条件静默会把业务错误也吞掉：本地那 +250 不显示、又没有提示，
    //   用户会以为「点了没反应」而反复点。
    onError: (error: unknown) => {
      if (!isNetworkError(error)) {
        setFeedback(COPY.waterAddMissed);
      }
    },
  });

  const undoWater = useMutation({
    mutationFn: () => api.delete<{ undone: boolean }>(`/water/last?date=${today}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.waterDay(today) }),
    // 同上：网络错误静默（本地已先撤），业务错误给一句中性软着陆。
    onError: (error: unknown) => {
      if (!isNetworkError(error)) {
        setFeedback(COPY.waterUndoMissed);
      }
    },
  });

  /** 离线兜底：把本地缓存一并更新（在线时以服务端返回为准）。 */
  const addWaterLocal = (): void => {
    const state = readLocalWater(today);
    const next: WaterState = {
      totalMl: state.totalMl + WATER_QUICK_ADD_ML,
      history: [...state.history, Date.now()],
    };
    cacheSet(`qsh:cache:water:${today}`, next);
    addWater.mutate();
  };

  const undoWaterLocal = (): void => {
    const state = readLocalWater(today);
    if (state.history.length === 0) {
      setFeedback('今天还没有可撤销的记录');
      return;
    }
    const next: WaterState = {
      totalMl: Math.max(0, state.totalMl - WATER_QUICK_ADD_ML),
      history: state.history.slice(0, -1),
    };
    cacheSet(`qsh:cache:water:${today}`, next);
    undoWater.mutate();
  };

  /**
   * PWA 桌面快捷方式「喝一杯水」的直达处理（C-2）。
   *
   * ## 语义
   *
   * 用户从桌面点「喝一杯水」，本页以 `/exercise?focus=water` 打开 → **直接记下一杯水**。
   * 刻意**不做**「聚焦高亮、还要再点一次」的折中：快捷方式的名字就是「喝一杯水」，
   * 用户点它就是要喝 —— 再要求一次点击等于没直达。喝水是**追加型**操作，
   * 误触发代价低且可撤销（本页已有「撤销上一条」→ `DELETE /water/last`）。
   *
   * ## 三道防重复闸门（缺一不可）
   *
   * 1. `useRef` 一次性闸门：React 18 StrictMode 会在开发环境**故意**把 effect
   *    挂载 → 卸载 → 再挂载（`main.tsx` 确实启用了 `StrictMode`），
   *    没有这道闸门就会一次直达记两杯；ref 跨「卸载再挂载」保持为真，故只放行第一次。
   * 2. **先摘参数再看闸门**：`?focus=water` 在本次直达后立即从 URL 移除，
   *    此后刷新页面 URL 是干净的 `/exercise`，不会再加一杯。
   * 3. 参数被摘除后 `searchParams.get('focus')` 变 `null`，effect 即便重跑也进不了分支。
   *
   * ## 反馈
   *
   * 复用既有 `addWaterLocal`（离线同时更新本地缓存），并以 `COPY.waterShortcutLogged`
   * 做**事实陈述**。⚠️ 不新增任何数字展示（如「今天第 N 杯」）—— 那需要 `/why-numbers`
   * 条目且带催办意味，违反硬约束 2 / NFR-11。
   */
  const shortcutHandled = useRef(false);
  useEffect(() => {
    if (shortcutHandled.current) {
      return;
    }
    if (searchParams.get('focus') !== 'water') {
      return;
    }
    shortcutHandled.current = true;
    // 先摘参数（replace 不污染浏览器历史），让本 effect 的重跑与后续刷新都读到干净 URL。
    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    setSearchParams(next, { replace: true });
    addWaterLocal();
    setShortcutNotice(COPY.waterShortcutLogged);
    // `searchParams` 变化后该 effect 会重跑，但闸门已置真 / 参数已摘除，不会再记一杯。
  }, [searchParams, setSearchParams]);

  const waterTotal = waterQuery.data?.totalMl ?? localWater.totalMl;
  const waterGoal = waterQuery.data?.goalMl ?? 2000;
  const waterPercent = Math.min(100, Math.round((waterTotal / Math.max(1, waterGoal)) * 100));

  const dayLogs = dayQuery.data?.logs ?? [];
  const dayTotal = dayQuery.data?.totalKcal ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 pb-24 pt-4" aria-live="polite">
      <section className="qsh-surface p-5">
        <h1 className="text-base font-semibold text-slate-800 dark:text-slate-100">动一动</h1>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          消耗 = MET × 体重 × 时长（估算值，来源见「参考来源」页）
        </p>

        <label className="mt-4 block text-sm text-slate-600 dark:text-slate-300" htmlFor="exercise-type">
          运动类型
        </label>
        <select
          id="exercise-type"
          className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-800 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
          value={activityCode}
          onChange={(event) => setActivityCode(event.target.value)}
        >
          {MET_ACTIVITY_LIBRARY.map((item) => (
            <option key={item.code} value={item.code}>
              {item.name}（MET {item.met}）
            </option>
          ))}
        </select>

        <label className="mt-4 block text-sm text-slate-600 dark:text-slate-300" htmlFor="exercise-minutes">
          时长（分钟）
        </label>
        <input
          id="exercise-minutes"
          type="number"
          min={1}
          max={480}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-slate-800 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
          value={minutes}
          onChange={(event) => setMinutes(Math.max(1, Math.min(480, Number(event.target.value) || 1)))}
        />

        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300" aria-live="polite">
          大约消耗 <span className="text-xl font-bold text-brand-600 dark:text-brand-400">{toDisplayEnergy(previewKcal, unit)}</span>{' '}
          {energyLabel(unit)}
        </p>

        <button
          type="button"
          className="mt-4 w-full rounded-xl bg-brand-600 px-4 py-3 font-medium text-white disabled:opacity-50"
          disabled={logExercise.isPending}
          onClick={() => logExercise.mutate()}
        >
          记下这次运动
        </button>
        {feedback ? <p className="mt-2 text-sm text-brand-700 dark:text-brand-400">{feedback}</p> : null}

        <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-700">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            今日运动消耗合计 <span className="font-bold">{toDisplayEnergy(dayTotal, unit)}</span> {energyLabel(unit)}
          </p>
          <ul className="mt-2 space-y-1 text-sm text-slate-500 dark:text-slate-400">
            {dayLogs.length === 0 ? (
              <li className="flex items-center gap-1.5">
                <BrandDecor variant="bloom" className="h-4 w-4 shrink-0 text-brand-300" />
                <span>今天还没有记录，散散步也算数</span>
              </li>
            ) : (
              dayLogs.map((log) => (
                <li key={log.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {log.activityName} · {log.minutes} 分钟 · 约 {toDisplayEnergy(log.kcalBurned, unit)} {energyLabel(unit)}
                  </span>
                  <button
                    type="button"
                    onClick={() => deleteExercise.mutate(log.id)}
                    disabled={deleteExercise.isPending}
                    aria-label={exerciseDeleteAria(log.activityName, log.minutes)}
                    data-testid={`exercise-delete-${log.id}`}
                    className="qsh-touch-target shrink-0 rounded-control px-2 text-xs text-slate-600 hover:text-coral-600 disabled:opacity-40 dark:text-slate-300"
                  >
                    {COPY.exerciseDelete}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </section>

      <section className="qsh-surface p-5">
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">喝水</h2>
        {/* 快捷方式直达反馈：事实陈述，不报杯数（硬约束 2 / NFR-11） */}
        {shortcutNotice ? (
          <p role="status" className="mt-1 text-sm text-sky-700 dark:text-sky-300">
            {shortcutNotice}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {waterTotal} / {waterGoal} ml（{waterPercent}%）
        </p>
        <div
          className="mt-2 h-3 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700"
          role="progressbar"
          aria-valuenow={waterPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="今日饮水进度"
        >
          <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${waterPercent}%` }} />
        </div>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            className="flex-1 rounded-xl bg-sky-500 px-4 py-3 font-medium text-white"
            onClick={addWaterLocal}
          >
            +{WATER_QUICK_ADD_ML}ml
          </button>
          <button
            type="button"
            className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-slate-600 dark:border-slate-600 dark:text-slate-300"
            onClick={undoWaterLocal}
          >
            撤销上一条
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{COPY.waterGentle}</p>
      </section>
    </div>
  );
}
