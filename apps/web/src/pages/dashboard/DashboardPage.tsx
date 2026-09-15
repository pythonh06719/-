import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { DashboardResponse } from '@qsh/shared-types';
import { isNetworkError } from '@/lib/api';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { CACHE_KEYS, cacheGet, cacheSet } from '@/lib/local-cache';
import { formatDateLabel, todayKey } from '@/lib/format';
import { energyLabel, toDisplayEnergy, useUnitStore } from '@/lib/units';
import { COPY, waterProgress } from '@/lib/copy';
import { DEFAULT_WATER_GOAL_ML, WATER_QUICK_ADD_ML } from '@/theme/tokens';
import BigNumber from '@/components/common/BigNumber';
import ProgressRing from '@/components/common/ProgressRing';
import Sparkline from '@/components/common/Sparkline';
import SafetyBanner from '@/components/feedback/SafetyBanner';
import EncouragementText from '@/components/feedback/EncouragementText';

/**
 * 今日看板（`/dashboard`，PRD §6 第 3 行 / US-05）。
 *
 * - 今日剩余热量**大数字** + 进度环（柔和渐变，无红色恐吓）
 * - 饮水小组件（一键 +250ml，可撤销上一条；一期为本地记录，二期接服务端）
 * - 迷你体重趋势（SVG sparkline）
 * - 一句鼓励语 + 引擎告警（按 code 去重渲染）
 *
 * 离线 / 后端未就绪时回退到本地缓存副本，绝不白屏（TC-47）。
 */

interface WaterState {
  totalMl: number;
  /** 最近一次添加的时间戳（用于「撤销上一条」） */
  history: number[];
}

const EMPTY_WATER: WaterState = { totalMl: 0, history: [] };

function readWater(date: string): WaterState {
  return cacheGet<WaterState>(`qsh:cache:water:${date}`) ?? EMPTY_WATER;
}

/** 由本地缓存的预算兜底构造看板数据（后端不可用时使用）。 */
function buildFallbackDashboard(date: string): DashboardResponse | null {
  const cached = cacheGet<DashboardResponse>(CACHE_KEYS.dashboard(date));
  if (cached !== null) {
    return cached;
  }
  const budget = cacheGet<DashboardResponse['budget']>(CACHE_KEYS.localBudget);
  if (budget === null) {
    return null;
  }
  return {
    date,
    goal: null,
    budget,
    intakeKcal: 0,
    burnedKcal: 0,
    remainingKcal: budget.intakeRecommended,
    progressRatio: 0,
    waterMl: 0,
    waterGoalMl: DEFAULT_WATER_GOAL_ML,
    miniTrend: [],
    encouragement: COPY.defaultEncouragement,
    warnings: [],
  };
}

export default function DashboardPage(): ReactElement {
  const date = todayKey();
  const unit = useUnitStore((state) => state.unit);
  const [water, setWater] = useState<WaterState>(() => readWater(date));

  const dashboardQuery = useQuery({
    queryKey: queryKeys.dashboard(date),
    queryFn: () => api.get<DashboardResponse>('/dashboard', { date }),
  });

  // 成功时写入缓存，供离线查看（TC-47）
  useEffect(() => {
    if (dashboardQuery.data !== undefined) {
      cacheSet(CACHE_KEYS.dashboard(date), dashboardQuery.data);
    }
  }, [dashboardQuery.data, date]);

  const offline = dashboardQuery.isError && isNetworkError(dashboardQuery.error);
  const data = useMemo<DashboardResponse | null>(
    () => dashboardQuery.data ?? buildFallbackDashboard(date),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dashboardQuery.data, date],
  );

  const persistWater = (next: WaterState): void => {
    setWater(next);
    cacheSet(`qsh:cache:water:${date}`, next);
  };

  const addWater = (): void => {
    persistWater({
      totalMl: water.totalMl + WATER_QUICK_ADD_ML,
      history: [...water.history, Date.now()],
    });
  };

  const undoWater = (): void => {
    if (water.history.length === 0) {
      return;
    }
    persistWater({
      totalMl: Math.max(0, water.totalMl - WATER_QUICK_ADD_ML),
      history: water.history.slice(0, -1),
    });
  };

  if (dashboardQuery.isLoading && data === null) {
    return (
      <section aria-busy="true" className="space-y-4">
        <div className="h-40 animate-pulse rounded-2xl bg-brand-100 dark:bg-slate-800" />
        <div className="h-24 animate-pulse rounded-2xl bg-brand-100 dark:bg-slate-800" />
        <p className="qsh-sr-only">正在读取今天的数据</p>
      </section>
    );
  }

  if (data === null) {
    return (
      <section className="space-y-5">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">今天开始记录吧</h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          先花一分钟做完引导，我们就能算出你的每日预算了。
        </p>
        <Link
          to="/onboarding"
          className="qsh-touch-target inline-flex rounded-xl bg-brand-600 px-5 py-3 font-medium text-white"
        >
          去做引导问卷
        </Link>
      </section>
    );
  }

  const remainingDisplay = toDisplayEnergy(data.remainingKcal, unit);
  const intakeDisplay = toDisplayEnergy(data.intakeKcal, unit);
  const budgetDisplay = toDisplayEnergy(data.budget?.intakeRecommended ?? 0, unit);
  const waterGoal = data.waterGoalMl > 0 ? data.waterGoalMl : DEFAULT_WATER_GOAL_ML;

  return (
    <section aria-labelledby="dashboard-title" className="space-y-5">
      <header className="flex items-baseline justify-between">
        <h1 id="dashboard-title" className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          今日看板
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{formatDateLabel(date)}</p>
      </header>

      {offline && (
        <p
          role="status"
          aria-live="polite"
          className="rounded-xl bg-coral-50 px-4 py-2 text-xs text-coral-700 dark:bg-coral-900/30 dark:text-coral-200"
        >
          {COPY.offlineNotice}
        </p>
      )}

      <div className="qsh-surface rounded-3xl p-6 dark:bg-slate-800 dark:ring-slate-700">
        <BigNumber
          caption="今日还能吃"
          value={remainingDisplay}
          unit={energyLabel(unit)}
          ariaLabel={`今日还能摄入 ${remainingDisplay} ${energyLabel(unit)}`}
          hint={
            data.remainingKcal < 0
              ? '今天吃得丰富一些，明天照常就好'
              : `已摄入 ${intakeDisplay} ${energyLabel(unit)} / 预算 ${budgetDisplay} ${energyLabel(unit)}`
          }
        />

        <div className="relative mt-6 flex justify-center">
          <ProgressRing
            value={data.progressRatio}
            centerValue={`${Math.round(Math.min(data.progressRatio, 9.99) * 100)}%`}
            centerLabel="今日进度"
            ariaLabel={`今日热量进度 ${Math.round(data.progressRatio * 100)}%`}
          />
        </div>
      </div>

      <div className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">喝水</h2>
          <p className="qsh-tnum text-sm text-slate-500 dark:text-slate-400">
            {water.totalMl} / {waterGoal} ml
          </p>
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400" role="status" aria-live="polite">
          {waterProgress(water.totalMl, waterGoal)}
        </p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={addWater}
            className="qsh-touch-target flex-1 rounded-xl bg-brand-600 py-3 font-medium text-white transition hover:bg-brand-700"
          >
            + {WATER_QUICK_ADD_ML} ml
          </button>
          <button
            type="button"
            onClick={undoWater}
            disabled={water.history.length === 0}
            className="qsh-touch-target rounded-xl px-4 text-sm text-slate-600 ring-1 ring-brand-100 disabled:opacity-40 dark:text-slate-300 dark:ring-slate-700"
            aria-label="撤销上一次喝水记录"
          >
            撤销上一条
          </button>
        </div>
      </div>

      <div className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">最近 7 天体重</h2>
        <div className="mt-3">
          <Sparkline data={data.miniTrend} />
        </div>
        <Link to="/weight" className="mt-3 inline-block text-sm font-medium text-brand-600 dark:text-brand-300">
          去看完整趋势 →
        </Link>
      </div>

      <div className="space-y-3">
        <SafetyBanner warnings={data.warnings} />
        <EncouragementText text={data.encouragement} />
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          to="/diary"
          className="qsh-touch-target flex-1 rounded-xl bg-brand-600 px-5 py-3 text-center font-medium text-white"
        >
          记一餐
        </Link>
        <Link
          to="/weight"
          className="qsh-touch-target flex-1 rounded-xl px-5 py-3 text-center font-medium text-brand-700 ring-1 ring-brand-200 dark:text-brand-200 dark:ring-slate-700"
        >
          记体重
        </Link>
      </div>
    </section>
  );
}
