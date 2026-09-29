import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateGoalRequest } from '@qsh/shared-types';
import { api, noticeFromError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { CACHE_KEYS, cacheSet } from '@/lib/local-cache';
import {
  COPY,
  goalTargetWeightInvalidFor,
  goalWeightInvalidFor,
  goalWeeksInvalidFor,
} from '@/lib/copy';
import type { ThemeBudget } from '@/theme/tokens';

/**
 * 「我的目标」编辑卡（`/profile`，AC-11.2.7）。
 *
 * ## 为什么单独成卡，而不是并进「基础数据」表单
 *
 * 「基础数据」（性别 / 出生日期 / 身高 / 活动量）回答的是「你是个什么样的人」，
 * 「目标」（体重 / 期限）回答的是「你想走到哪儿」—— 两类语义不同，后端也是**两条路由**
 * （`PATCH /profile` 与 `PATCH /goals`）。合成一个表单会让「保存」这个动作的含义变模糊
 * （改身高和改目标走同一个按钮？），也让校验范围互相牵连。故独立成卡、独立提交。
 *
 * ## 位置
 *
 * 紧挨「当前热量预算」卡：目标**直接决定**预算（缺口 = 每周目标减重），
 * 两者相邻，用户改完目标能立刻在上一屏看到预算变化，因果最直观。
 *
 * ## 语义要点（AC-11.2.7 的落地）
 *
 * - **部分更新**：`PATCH /goals` 的 body **只带改动过的字段**（未动的字段省略即保留现值），
 *   后端 `updateProfile` 对未传字段一律 `dto.X ?? goal.X`。
 * - **「维持模式」无需在此处理**：它由「当前体重 vs 目标体重」实时派生
 *   （`packages/core` 的 `buildGoalProgress` / `weights.service`），
 *   目标一改，下次计算自动不再是维持模式 —— 这里不写任何「退出维持模式」的代码。
 * - **不暴露 `macroRatio`**：宏量比例由引导问卷根据饮食偏好算出，对多数用户是「黑箱」，
 *   单独暴露三个百分比输入既容易配错（三者和须 = 100），又几乎没有可解释的收益。
 *   本期只开放「体重 / 期限」两类用户真正会反复调整的目标。
 * - **不展示任何新数字**：本卡只回显用户自己填的现值（当前体重 / 目标体重 / 期限），
 *   以及成功后「预算已重算」这一事实（预算口径在 `/why-numbers` 第 ① 条已解释）。
 *   故**未改动 `/why-numbers`**。
 *
 * 语气（PRD §7）：目标是方向、不是任务 —— 文案只说「改」，从不出现「达成 / 必须 / 坚持」。
 */

/** `/profile` 响应中本卡需要的最小结构（宽容以容忍服务端附加字段）。 */
interface GoalProfileResult {
  goal: {
    startWeightKg: number;
    targetWeightKg: number;
    targetWeeks: number;
  } | null;
}

/** 与后端 `UpdateGoalDto` 对齐的校验范围（前端先拦，避免提交必被 400 的值）。 */
const WEIGHT_MIN = 20;
const WEIGHT_MAX = 400;
const TARGET_MIN = 1;
const TARGET_MAX = 400;
const WEEKS_MIN = 1;
const WEEKS_MAX = 260;

interface EditGoalState {
  currentWeightKg: string;
  targetWeightKg: string;
  targetWeeks: string;
}

const INITIAL_EDIT: EditGoalState = {
  currentWeightKg: '',
  targetWeightKg: '',
  targetWeeks: '',
};

/** 把输入串解析为有限数（空串 / 非数字 → `NaN`）。 */
function parseNumber(raw: string): number {
  const trimmed = raw.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

/** 是否为区间内的有限数。 */
function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

export default function GoalSettingsCard(): ReactElement | null {
  const queryClient = useQueryClient();
  const [edit, setEdit] = useState<EditGoalState>(INITIAL_EDIT);
  const [notice, setNotice] = useState<string | null>(null);

  const profileQuery = useQuery({
    queryKey: queryKeys.profile,
    queryFn: () => api.get<GoalProfileResult>('/profile'),
  });

  const goal = profileQuery.data?.goal ?? null;

  // 服务端数据到达 / 目标变更后回填编辑表单
  useEffect(() => {
    if (
      goal !== null &&
      Number.isFinite(goal.startWeightKg) &&
      Number.isFinite(goal.targetWeightKg) &&
      Number.isFinite(goal.targetWeeks)
    ) {
      setEdit({
        currentWeightKg: String(goal.startWeightKg),
        targetWeightKg: String(goal.targetWeightKg),
        targetWeeks: String(goal.targetWeeks),
      });
    }
  }, [goal]);

  const updateGoal = useMutation({
    mutationFn: (payload: UpdateGoalRequest) =>
      api.patch<{ budget: ThemeBudget }>('/goals', payload),
    onSuccess: (data) => {
      // 断网时预算卡走本地缓存兜底 —— 成功后顺手把新预算写进缓存，避免离线看到旧值
      if (data !== null && typeof data === 'object' && 'budget' in data) {
        cacheSet(CACHE_KEYS.localBudget, data.budget);
      }
      setNotice(COPY.goalSaved);
      // 目标变了 → 预算、看板、体重进度全部需要重取（服务端为唯一权威）
      void queryClient.invalidateQueries({ queryKey: queryKeys.profile });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['weights'] });
    },
    onError: (error: unknown) => setNotice(noticeFromError(error, COPY.goalSaveMissed)),
  });

  // 未完成引导（无生效目标）：给一句中性说明，不渲染表单
  if (goal === null) {
    return (
      <section
        aria-labelledby="goal-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="goal-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          {COPY.goalCardTitle}
        </h2>
        <p role="status" className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {COPY.goalCardEmpty}
        </p>
      </section>
    );
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const currentWeightKg = parseNumber(edit.currentWeightKg);
    const targetWeightKg = parseNumber(edit.targetWeightKg);
    const targetWeeks = parseNumber(edit.targetWeeks);

    if (!inRange(currentWeightKg, WEIGHT_MIN, WEIGHT_MAX)) {
      setNotice(goalWeightInvalidFor(WEIGHT_MIN, WEIGHT_MAX));
      return;
    }
    if (!inRange(targetWeightKg, TARGET_MIN, TARGET_MAX)) {
      setNotice(goalTargetWeightInvalidFor(TARGET_MIN, TARGET_MAX));
      return;
    }
    if (
      !Number.isInteger(targetWeeks) ||
      !inRange(targetWeeks, WEEKS_MIN, WEEKS_MAX)
    ) {
      setNotice(goalWeeksInvalidFor(WEEKS_MIN, WEEKS_MAX));
      return;
    }

    // 部分更新：只带真正改动过的字段
    const payload: UpdateGoalRequest = {};
    if (currentWeightKg !== goal.startWeightKg) payload.currentWeightKg = currentWeightKg;
    if (targetWeightKg !== goal.targetWeightKg) payload.targetWeightKg = targetWeightKg;
    if (targetWeeks !== goal.targetWeeks) payload.targetWeeks = targetWeeks;

    if (Object.keys(payload).length === 0) {
      setNotice(COPY.goalNoChange);
      return;
    }

    setNotice(null);
    updateGoal.mutate(payload);
  };

  return (
    <section
      aria-labelledby="goal-title"
      className="qsh-surface space-y-3 rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
    >
      <h2 id="goal-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
        {COPY.goalCardTitle}
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">{COPY.goalCardDesc}</p>

      {/* 现值：让用户一眼看到「现在的目标是什么」（否则改之前无从对照） */}
      <dl
        aria-label={COPY.goalCurrentTitle}
        data-testid="goal-current"
        className="grid grid-cols-3 gap-3 text-center"
      >
        <div className="rounded-xl bg-brand-50 p-3 dark:bg-brand-900/40">
          <dt className="text-xs text-slate-600 dark:text-slate-400">
            {COPY.goalCurrentWeightLabel}
          </dt>
          <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
            {goal.startWeightKg} kg
          </dd>
        </div>
        <div className="rounded-xl bg-brand-50 p-3 dark:bg-brand-900/40">
          <dt className="text-xs text-slate-600 dark:text-slate-400">
            {COPY.goalTargetWeightLabel}
          </dt>
          <dd className="qsh-tnum mt-1 font-semibold text-brand-700 dark:text-brand-200">
            {goal.targetWeightKg} kg
          </dd>
        </div>
        <div className="rounded-xl bg-brand-50 p-3 dark:bg-brand-900/40">
          <dt className="text-xs text-slate-600 dark:text-slate-400">
            {COPY.goalTargetWeeksLabel}
          </dt>
          <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
            {goal.targetWeeks} 周
          </dd>
        </div>
      </dl>

      <form
        data-testid="goal-form"
        className="space-y-3 border-t border-slate-100 pt-3 dark:border-slate-700"
        onSubmit={handleSubmit}
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">{COPY.goalEditHint}</p>
        <div className="grid grid-cols-3 gap-3">
          <label className="text-sm text-slate-600 dark:text-slate-300">
            {COPY.goalCurrentWeightLabel}
            <input
              data-testid="goal-input-current"
              inputMode="decimal"
              value={edit.currentWeightKg}
              onChange={(event) => setEdit((prev) => ({ ...prev, currentWeightKg: event.target.value }))}
              className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          <label className="text-sm text-slate-600 dark:text-slate-300">
            {COPY.goalTargetWeightLabel}
            <input
              data-testid="goal-input-target"
              inputMode="decimal"
              value={edit.targetWeightKg}
              onChange={(event) => setEdit((prev) => ({ ...prev, targetWeightKg: event.target.value }))}
              className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          <label className="text-sm text-slate-600 dark:text-slate-300">
            {COPY.goalTargetWeeksLabel}
            <input
              data-testid="goal-input-weeks"
              inputMode="numeric"
              value={edit.targetWeeks}
              onChange={(event) => setEdit((prev) => ({ ...prev, targetWeeks: event.target.value }))}
              className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={updateGoal.isPending}
          className="qsh-touch-target w-full rounded-xl bg-brand-600 py-3 font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          {updateGoal.isPending ? COPY.goalSaving : COPY.goalSaveButton}
        </button>
        {notice !== null && (
          <p
            role="status"
            aria-live="polite"
            data-testid="goal-notice"
            className="text-sm text-brand-700 dark:text-brand-300"
          >
            {notice}
          </p>
        )}
      </form>
    </section>
  );
}
