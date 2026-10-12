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
import { resolveWaterGoalMl } from '@/lib/water-goal';
import { enqueueRequest } from '@/pwa/offline-queue';
import { WATER_QUICK_ADD_ML } from '@/theme/tokens';
import BrandDecor from '@/components/common/BrandDecor';
import WaterGoalCard from '@/pages/exercise/WaterGoalCard';

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

/**
 * `GET /exercises` 的返回形态：整日汇总（列表 + 合计）。
 *
 * ⚠️ 与下面的 `ExerciseLogDto` **刻意分成两个类型**：`POST /exercises` 返回的是单条记录，
 * 曾有人把它断言成 `ExerciseDay` 塞进当日汇总缓存 —— 假断言让编译器也帮着说谎
 * （详见 `logExercise` 处的注释）。分成两个类型后，两者不可再互相当用。
 */
interface ExerciseDay {
  date: string;
  logs: Array<{ id: number; activityName: string; minutes: number; kcalBurned: number }>;
  totalKcal: number;
}

/**
 * `POST /exercises` 的返回形态（后端 `ExerciseLogDto`）—— **单条记录**，不是整日汇总。
 *
 * 字段只有 `id / loggedDate / activityCode / activityName / met / minutes / kcalBurned / note`：
 * **没有 `logs`、没有 `totalKcal`**。后端契约不改（miniprogram 也在用同一端点），前端只能适配。
 */
interface ExerciseLogDto {
  id: number;
  loggedDate: string;
  activityCode: string;
  activityName: string;
  met: number;
  minutes: number;
  kcalBurned: number;
  note: string | null;
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

/* --------------------------------------------------------------------------- *
 * 本页新增文案的**临时**落点。
 *
 * ⚠️ `lib/copy.ts` 本轮被多个任务共用，为避开写冲突，新增文案先放在本文件内；
 * 下一轮统一归位到 `COPY` 时，只需改这三个常量的定义处，调用点一行不动。
 * ------------------------------------------------------------------------- */

/**
 * 离线删除运动记录的反馈：**排队态**措辞，不是完成态。
 *
 * 为什么不能用 `COPY.exerciseDeleted`（「已经删掉了」）：离线删除走的是
 * `enqueueRequest()` 入队 —— 而离线队列重放 3 次失败后是**静默丢弃**的
 * （`pwa/offline-queue.ts` 的 `flush()`），也就是说这条删除**可能在服务端永远没发生**。
 * UI 若宣告「已删除」，用户下次联网会看到那条记录又回来了，且没有任何解释 ——
 * 一句完成态的话把不确定的结果说成了既成事实。
 * 故这里只说「先记下、待同步」，**不承诺结果**（不出现「一定 / 保证」）；
 * 乐观移除缓存保留（用户当下确实需要它从眼前消失）。
 */
export const EXERCISE_DELETE_QUEUED = '这次删除先记下了，等网络恢复后同步';

/**
 * 运动列表降级时的来源说明。
 *
 * 点名「运动记录」与「今日合计」这两个元素，而不是「这些」—— 同屏还有饮水那条提示，
 * 两句一字不差会被读成重复渲染，且对读屏用户指代不明。
 */
export const EXERCISE_STALE_NOTICE = '这些运动记录和今日合计是上次同步时的，网络恢复后会自动更新。';

/** 饮水降级时的来源说明（点名「饮水进度」，与上面那条不重字）。 */
export const WATER_STALE_NOTICE = '饮水进度是上次同步时的数据，网络恢复后会自动更新。';

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

  /**
   * 记一条运动。
   *
   * ⚠️ `mutationFn` 的泛型是 `ExerciseLogDto`（单条），**不是** `ExerciseDay`（整日汇总）。
   *
   * 此前这里断言成 `ExerciseDay` 并把返回值直接 `setQueryData` 进当日汇总缓存 ——
   * 于是缓存里的 `logs` / `totalKcal` 双双为 `undefined`，被下游的 `?? []` / `?? 0`
   * 静默吞掉：用户点完「记下这次运动」看到「记上啦」的提示，下面的列表却变空、
   * 今日合计变 0，必须手动刷新才恢复。**假的类型断言比没有断言更危险** ——
   * 它让类型检查也帮着说谎，而 `??` 又把谎言包装成了「没有数据」这种合法状态。
   *
   * 治根做法：**不猜返回形态**，成功后让真查询自己去取（`invalidateQueries`）。
   * 顺带失效报表（`reportQueryFilter()`）：新增运动同样会改变周报的 `exerciseKcal` /
   * `totalExerciseKcal`、阶段回顾的 `exercise` 与足迹日历，此前只有删除路径失效了它们，
   * 报表在 30 秒 `staleTime` 内仍是旧数字。
   */
  const logExercise = useMutation({
    mutationFn: () => api.post<ExerciseLogDto>('/exercises', { activityCode, minutes, loggedDate: today }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.exerciseDay(today) });
      void queryClient.invalidateQueries(reportQueryFilter());
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
        // ⚠️ 这里**不能**用 `COPY.exerciseDeleted`（「已经删掉了」）：入队不等于删除成功，
        // 队列重放 3 次失败后是静默丢弃的。排队态措辞，不承诺结果（详见常量处注释）。
        setFeedback(EXERCISE_DELETE_QUEUED);
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
  /**
   * 进度分母走 `resolveWaterGoalMl()`（**本机值优先**），不直接吃 `GET /water` 的 `goalMl`。
   *
   * ⚠️ 这里曾经硬写 `waterQuery.data?.goalMl ?? 2000` —— 同一屏的 `WaterGoalCard`
   * 输入框走的是本机优先，两处分母口径不一致会「自己打架」：离线把目标改成 2600 ml
   * → `pushSettings` 失败、该字段被标 dirty（`settings-sync` 的 P0-2）→ 进度条分母仍是
   * 服务端的 2000（百分比按错的基数算），而输入框里显示 2600。
   * 现在两处都走同一个 helper，`/why-numbers` ㉖「本机有效偏好 > 服务端 goalMl >
   * 默认 2000 ml」在代码里真正成立（本机值未推送成功前必须胜出）。
   *
   * `undefined`（未加载 / 离线）由 helper 内部回退，不需要页面另写判据。
   */
  const waterGoal = resolveWaterGoalMl(waterQuery.data?.goalMl);
  const waterPercent = Math.min(100, Math.round((waterTotal / Math.max(1, waterGoal)) * 100));

  const dayLogs = dayQuery.data?.logs ?? [];
  const dayTotal = dayQuery.data?.totalKcal ?? 0;

  /**
   * 「现在看到的是上次同步的数据」—— **两个查询各判一次，刻意不合并**。
   *
   * ## 为什么必须有这个标记（数字可信度，不是视觉细节）
   *
   * `dayQuery` / `waterQuery` 失败时，react-query 会**原样保留**上一次成功的 `data`
   * （只把 `isError` 置真，不动 `data`）；饮水还另有一条退路 —— 退到本机缓存 `localWater`。
   * 于是「0 / 2000 ml（0%）」和「1500 / 2000 ml（75%）」在屏幕上长得一模一样，用户
   * 分不出哪个是刚取回来的。看到「今天一口水没喝」就会连点 +250ml —— 这是数字不可信，
   * 不是配色或排版问题。
   *
   * ## 为什么只认 `isNetworkError`
   *
   * **业务错误（500）不挂这条提示**：「网络好像不太稳」会把用户引去查 WiFi，而问题在服务端 ——
   * 归因不准比不提示更糟（不提示只让人困惑，错误归因让人做错事）。
   * 业务错误由各自既有的中性提示负责（如 `COPY.waterAddMissed`）。
   *
   * ## 为什么还要「有兜底值」这一半判据
   *
   * 只有屏幕上**确实**渲染了旧数字时才说这句话。否则（首次进入就断网、本机也没缓存）
   * 页面本来就没东西可展示，挂一条「这些是上次同步的」是在指控一个不存在的展示 ——
   * 与 `WeightPage` 的 `allPoints.length > 0`、`DiaryPage` 的 `hasAnyLog` 同一口径。
   *
   * ## 为什么分成两条而不是合并
   *
   * `GET /exercises` 与 `GET /water` 是两个**互不相干**的请求，失效时刻可以一个通一个不通。
   * 合并成一句就说不清是「运动的数字」旧了还是「喝水的数字」旧了 —— **说不清等于没说**。
   * 两条各有自己的 `refetch()`，点哪条修哪条。
   */
  const showingStaleExercise =
    dayQuery.isError && isNetworkError(dayQuery.error) && (dayQuery.data?.logs.length ?? 0) > 0;
  /** 饮水的兜底值有两条来源：react-query 的上次成功结果，或本机缓存（离线时点 +250ml 写的那份）。 */
  const showingStaleWater =
    waterQuery.isError &&
    isNetworkError(waterQuery.error) &&
    (waterQuery.data !== undefined || localWater.totalMl > 0);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 pb-24 pt-4" aria-live="polite">
      <section className="qsh-surface p-5">
        <h1 className="text-title font-semibold text-slate-800 dark:text-slate-100">动一动</h1>
        <p className="mt-tight text-xs text-slate-500 dark:text-slate-400">
          消耗 = MET × 体重 × 时长（估算值，来源见「参考来源」页）
        </p>

        <label className="mt-4 block text-sm text-slate-600 dark:text-slate-300" htmlFor="exercise-type">
          运动类型
        </label>
        <select
          id="exercise-type"
          className="mt-tight w-full rounded-control border border-slate-200 bg-white px-3 py-2 text-slate-800 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
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
          className="mt-tight w-full rounded-control border border-slate-200 px-3 py-2 text-slate-800 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
          value={minutes}
          onChange={(event) => setMinutes(Math.max(1, Math.min(480, Number(event.target.value) || 1)))}
        />

        <p className="mt-block text-sm text-slate-600 dark:text-slate-300" aria-live="polite">
          大约消耗 <span className="text-xl font-bold text-brand-600 dark:text-brand-400">{toDisplayEnergy(previewKcal, unit)}</span>{' '}
          {energyLabel(unit)}
        </p>

        <button
          type="button"
          className="mt-4 w-full rounded-control bg-brand-600 px-4 py-3 font-medium text-white transition-colors duration-qsh-fast ease-qsh-out disabled:opacity-50"
          disabled={logExercise.isPending}
          onClick={() => logExercise.mutate()}
        >
          记下这次运动
        </button>
        {feedback ? <p className="mt-2 text-sm text-brand-700 dark:text-brand-400">{feedback}</p> : null}

        <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-700">
          {/*
            「这些是上次同步时的」标记（数据可信度 · 与体重页 `weight-stale-notice` 同形）。

            位置在「今日运动消耗合计」**之上**：这一行与下面的列表是同一份 `dayQuery.data`
            推出的两个数字，提示放在数字之前才读得通「接下来这些数字都是旧的」。

            语气与配色：中性陈述（灰底 + 品牌色重试按钮），**不用红、不用警示色、不弹窗、
            不遮挡、不禁用任何操作**（照抄 `WeightPage` / `DiaryPage` 已定型的做法）。
            出路同屏可达：`重新试试` 直接重跑本查询，成功后本条自动消失。
          */}
          {showingStaleExercise && (
            <div
              role="status"
              aria-live="polite"
              data-testid="exercise-stale-notice"
              className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control bg-slate-100 px-4 py-2 text-caption text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              <span>{EXERCISE_STALE_NOTICE}</span>
              <button
                type="button"
                onClick={() => {
                  void dayQuery.refetch();
                }}
                disabled={dayQuery.isFetching}
                // 可及名以可见文案开头（WCAG 2.5.3 Label in Name），并补上「同步运动记录」
                // —— 同屏还有饮水那个同名按钮，不点名会让读屏用户分不清点的是哪一个。
                aria-label={`${COPY.staleDataRetry}同步运动记录`}
                className="qsh-touch-target rounded-control px-2 py-1 font-medium text-brand-700 underline underline-offset-2 disabled:opacity-60 dark:text-brand-300"
              >
                {dayQuery.isFetching ? COPY.staleDataRetrying : COPY.staleDataRetry}
              </button>
            </div>
          )}
          <p className="text-sm text-slate-600 dark:text-slate-300">
            今日运动消耗合计 <span className="font-bold">{toDisplayEnergy(dayTotal, unit)}</span> {energyLabel(unit)}
          </p>
          <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">
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
        <h2 className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">喝水</h2>
        {/* 快捷方式直达反馈：事实陈述，不报杯数（硬约束 2 / NFR-11）
            颜色接品牌色 brand（实测 on 白底 6.50:1 / 深色面 8.47:1，均过 AA）；
            改前用的是冷蓝（Tailwind 内置色，全站仅饮水模块一处），与看板的绿色对不上。 */}
        {shortcutNotice ? (
          <p role="status" className="mt-tight text-sm text-brand-700 dark:text-brand-300">
            {shortcutNotice}
          </p>
        ) : null}
        {/*
          「饮水进度是上次同步时的」标记 —— **刻意与运动那条分开**（理由见
          `showingStaleWater` 的注释：两个请求各自失效，合并会让指代不明）。

          位置在 `{waterTotal} / {waterGoal}` 那行**之上**：本条说的就是这一行与它下面的进度条。
          文案点名「饮水进度」，与运动那条不重字 —— 同屏两句一字不差的提示会被读成重复渲染。
        */}
        {showingStaleWater && (
          <div
            role="status"
            aria-live="polite"
            data-testid="water-stale-notice"
            className="mt-tight flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control bg-slate-100 px-4 py-2 text-caption text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          >
            <span>{WATER_STALE_NOTICE}</span>
            <button
              type="button"
              onClick={() => {
                void waterQuery.refetch();
              }}
              disabled={waterQuery.isFetching}
              aria-label={`${COPY.staleDataRetry}同步饮水记录`}
              className="qsh-touch-target rounded-control px-2 py-1 font-medium text-brand-700 underline underline-offset-2 disabled:opacity-60 dark:text-brand-300"
            >
              {waterQuery.isFetching ? COPY.staleDataRetrying : COPY.staleDataRetry}
            </button>
          </div>
        )}
        <p className="mt-tight text-xs text-slate-500 dark:text-slate-400">
          {waterTotal} / {waterGoal} ml（{waterPercent}%）
        </p>
        <div
          className="mt-2 h-3 w-full overflow-hidden rounded-pill bg-slate-100 dark:bg-slate-700"
          role="progressbar"
          aria-valuenow={waterPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="今日饮水进度"
        >
          {/* 进度填充用 brand-500：与 `DiaryPage` 预算条 / `WeeklyReportView` 迷你柱同一档位，
              实测 vs 轨道 3.05:1（浅）/ 3.10:1（深），均过 1.4.11 的 3:1 ——
              改前的冷蓝填充只有 1.96:1（浅色轨道上几乎看不出填充到哪）。 */}
          <div className="h-full rounded-pill bg-brand-500 transition-[width] duration-qsh-slow ease-qsh-out" style={{ width: `${waterPercent}%` }} />
        </div>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            className="flex-1 rounded-control bg-brand-600 px-4 py-3 font-medium text-white transition-colors duration-qsh-fast ease-qsh-out hover:bg-brand-700"
            onClick={addWaterLocal}
          >
            +{WATER_QUICK_ADD_ML}ml
          </button>
          <button
            type="button"
            className="flex-1 rounded-control border border-slate-200 px-4 py-3 text-slate-600 dark:border-slate-600 dark:text-slate-300"
            onClick={undoWaterLocal}
          >
            撤销上一条
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{COPY.waterGentle}</p>
      </section>

      {/* 每日饮水目标编辑（GAP-3）：紧接喝水卡 —— 这里刚展示过 `0 / 2000 ml`，
          用户正是在此处「看见」那个目标，把「可以改」放在同一处最易被发现。
          当前值取本页已有的 `GET /water` 的 `goalMl`（不额外发请求）。 */}
      <WaterGoalCard serverGoalMl={waterQuery.data?.goalMl} />
    </div>
  );
}
