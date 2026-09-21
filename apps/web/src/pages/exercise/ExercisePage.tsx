import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MET_ACTIVITY_LIBRARY, calcExerciseKcal } from '@qsh/core';
import { api, isNetworkError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { CACHE_KEYS, cacheGet, cacheSet } from '@/lib/local-cache';
import { todayKey } from '@/lib/format';
import { COPY } from '@/lib/copy';
import BrandDecor from '@/components/common/BrandDecor';

/**
 * 运动与饮水（`/exercise`，PRD §6 第 5 行 / R6.1~R6.3，二期）。
 *
 * - MET 表来自 `@qsh/core`（前后端同一真源），消耗 = MET × 体重 × 时长（服务端按档案体重计算）
 * - 饮水：一键 +250ml、可撤销上一条；在线走服务端，离线回退本地缓存（与看板共用同一缓存键）
 * - 后端未就绪时优雅降级，不白屏（T04 DoD）
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

/** 与看板共用同一本地缓存键（离线兜底的一致性来源）。 */
function readLocalWater(date: string): WaterState {
  return cacheGet<WaterState>(`qsh:cache:water:${date}`) ?? EMPTY_WATER;
}

export default function ExercisePage(): ReactElement {
  const queryClient = useQueryClient();
  const today = todayKey();
  const [activityCode, setActivityCode] = useState<string>('walking_brisk');
  const [minutes, setMinutes] = useState<number>(30);
  const [feedback, setFeedback] = useState<string>('');

  const activity = MET_ACTIVITY_LIBRARY.find((item) => item.code === activityCode) ?? MET_ACTIVITY_LIBRARY[0]!;
  /** 本地即时预估（与服务端公式一致：MET × 体重 × 时长；体重取默认 60，服务端会按档案精确计算） */
  const previewKcal = useMemo(() => calcExerciseKcal(activity.met, 60, minutes), [activity, minutes]);

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

  const addWater = useMutation({
    mutationFn: () => api.post<WaterDay>('/water', { loggedDate: today }),
    onSuccess: (day) => void queryClient.setQueryData(queryKeys.waterDay(today), day),
    onError: () => undefined, // 离线时静默落到本地缓存
  });

  const undoWater = useMutation({
    mutationFn: () => api.delete<{ undone: boolean }>(`/water/last?date=${today}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.waterDay(today) }),
    onError: () => undefined,
  });

  /** 离线兜底：把本地缓存一并更新（在线时以服务端返回为准）。 */
  const addWaterLocal = (): void => {
    const state = readLocalWater(today);
    const next: WaterState = { totalMl: state.totalMl + 250, history: [...state.history, Date.now()] };
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
      totalMl: Math.max(0, state.totalMl - 250),
      history: state.history.slice(0, -1),
    };
    cacheSet(`qsh:cache:water:${today}`, next);
    undoWater.mutate();
  };

  const waterTotal = waterQuery.data?.totalMl ?? localWater.totalMl;
  const waterGoal = waterQuery.data?.goalMl ?? 2000;
  const waterPercent = Math.min(100, Math.round((waterTotal / Math.max(1, waterGoal)) * 100));

  const dayLogs = dayQuery.data?.logs ?? [];
  const dayTotal = dayQuery.data?.totalKcal ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 pb-24 pt-4" aria-live="polite">
      <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-slate-800">
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">动一动</h2>
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
          大约消耗 <span className="text-xl font-bold text-brand-600 dark:text-brand-400">{previewKcal}</span> kcal
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
            今日运动消耗合计 <span className="font-bold">{dayTotal}</span> kcal
          </p>
          <ul className="mt-2 space-y-1 text-sm text-slate-500 dark:text-slate-400">
            {dayLogs.length === 0 ? (
              <li className="flex items-center gap-1.5">
                <BrandDecor variant="bloom" className="h-4 w-4 shrink-0 text-brand-300" />
                <span>今天还没有记录，散散步也算数</span>
              </li>
            ) : (
              dayLogs.map((log) => (
                <li key={log.id}>
                  {log.activityName} · {log.minutes} 分钟 · 约 {log.kcalBurned} kcal
                </li>
              ))
            )}
          </ul>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-slate-800">
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">喝水</h2>
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
            +250ml
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
