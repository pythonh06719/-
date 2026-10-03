import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  ActivityLevel,
  Gender,
  OnboardingResponse,
  UpdateProfileRequest,
} from '@qsh/shared-types';
import { ACTIVITY_FACTORS, ageFromBirthDate, safeCalcCalorieBudget } from '@qsh/core';
import { api, ApiClientError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { CACHE_KEYS, cacheGet, cacheSet } from '@/lib/local-cache';
import { todayKey } from '@/lib/format';
import { COPY } from '@/lib/copy';
import { useAuthStore } from '@/lib/auth.store';
import { energyLabel, toDisplayEnergy, useUnitStore } from '@/lib/units';
import type { ThemeBudget } from '@/theme/tokens';
import LoginCard from '@/components/common/LoginCard';
import SafetyBanner from '@/components/feedback/SafetyBanner';
import ReminderSettings from '@/pages/profile/ReminderSettings';
import GoalSettingsCard from '@/pages/profile/GoalSettingsCard';

/**
 * 我的（`/profile`，PRD §6 第 12 行 / R1.4 / R2.9 / US-05 / TC-12 / TC-14）。
 *
 * - 基础数据修改 → `PATCH /api/profile` → **服务端自动重算**并返回新预算（唯一可信来源）
 * - 参考来源页：Mifflin-St Jeor（1990）、WHO BMI 标准、2024 成人活动 MET 汇编（数字可溯源）
 * - 登录卡片（一期无独立登录路由，故内嵌于此）
 * - 入口：数据导出 / 导入 / 删除（`/settings/data`）
 */

const ACTIVITY_OPTIONS: ReadonlyArray<{ value: ActivityLevel; label: string }> = [
  { value: 'sedentary', label: `久坐（${ACTIVITY_FACTORS.sedentary}）` },
  { value: 'light', label: `轻度活动（${ACTIVITY_FACTORS.light}）` },
  { value: 'moderate', label: `中度活动（${ACTIVITY_FACTORS.moderate}）` },
  { value: 'high', label: `高强度（${ACTIVITY_FACTORS.high}）` },
  { value: 'athlete', label: `运动员（${ACTIVITY_FACTORS.athlete}）` },
];

interface EditState {
  gender: Gender;
  birthDate: string;
  heightCm: string;
  activityLevel: ActivityLevel;
}

const INITIAL_EDIT: EditState = {
  gender: 'female',
  birthDate: '1995-01-01',
  heightCm: '165',
  activityLevel: 'sedentary',
};

interface MoreLink {
  /** 目标路由 */
  to: string;
  /** 链接文案（走 `copy.ts`，可读、非图标-only，满足无障碍要求） */
  label: string;
  /** 可选的补充说明（仅断食计时用到：点明「开关在这里」） */
  hint?: string;
}

/**
 * 「我的」页 · 更多功能区的导航条目。
 *
 * 这里集中列出**不在底部导航里的页面**，作为导航兜底 —— 用户从应用内任意位置
 * 出发都能到达（`BottomNav` 的四项刻意保持不变，见其注释）。
 *
 * ⚠️ **断食计时（`/fasting`）固定放在最前**：它是全站**唯一**能开关断食功能的地方
 * （`FastingPage` 的「关闭断食功能」按钮），此前没有任何入口，必须显眼、好找。
 */
const MORE_LINKS: ReadonlyArray<MoreLink> = [
  { to: '/fasting', label: COPY.profileMoreFasting, hint: COPY.profileMoreFastingHint },
  { to: '/ai', label: COPY.profileMoreAi },
  { to: '/exercise', label: COPY.profileMoreExercise },
  { to: '/habits', label: COPY.profileMoreHabits },
  { to: '/tools', label: COPY.profileMoreTools },
  { to: '/report', label: COPY.profileMoreReport },
  { to: '/why-numbers', label: COPY.profileMoreWhyNumbers },
];

export default function ProfilePage(): ReactElement {
  const unit = useUnitStore((state) => state.unit);
  const accessToken = useAuthStore((state) => state.accessToken);
  const user = useAuthStore((state) => state.user);
  const clear = useAuthStore((state) => state.clear);
  const [edit, setEdit] = useState<EditState>(INITIAL_EDIT);
  const [notice, setNotice] = useState<string | null>(null);

  const profileQuery = useQuery({
    queryKey: queryKeys.profile,
    queryFn: () => api.get<OnboardingResponse>('/profile'),
  });

  const updateProfile = useMutation({
    mutationFn: (payload: UpdateProfileRequest) =>
      api.patch<OnboardingResponse>('/profile', payload),
    onSuccess: (data) => {
      cacheSet(CACHE_KEYS.localBudget, data.budget);
      setNotice('基础数据已更新，预算已经重新算好');
    },
    onError: (error: unknown) =>
      setNotice(error instanceof ApiClientError ? error.message : '这次没有保存成功，稍后再试一次'),
  });

  const remote = profileQuery.data ?? null;
  const cachedBudget = cacheGet<ThemeBudget>(CACHE_KEYS.localBudget);

  // 服务端数据到达后回填编辑表单
  // 新账号（未完成引导问卷）的 `profile` / `goal` 为 null —— 用引导默认值兜底，页面不白屏
  useEffect(() => {
    if (remote !== null) {
      setEdit({
        gender: remote.profile?.gender ?? 'female',
        birthDate: remote.profile?.birthDate ?? '2000-01-01',
        heightCm: String(remote.profile?.heightCm ?? 165),
        activityLevel: remote.profile?.activityLevel ?? 'light',
      });
    }
  }, [remote]);

  /** 本地实时预览（服务端不可用时的兜底展示，UI 不至于空白）。 */
  const localPreview = useMemo(() => {
    const age = ageFromBirthDate(edit.birthDate, new Date());
    const heightCm = Number(edit.heightCm);
    const goal = remote?.goal;
    const currentWeight = goal?.startWeightKg ?? 60;
    return safeCalcCalorieBudget({
      gender: edit.gender,
      age,
      heightCm,
      weightKg: currentWeight,
      targetWeightKg: goal?.targetWeightKg ?? Math.max(currentWeight - 5, 30),
      targetWeeks: goal?.targetWeeks ?? 12,
      activityLevel: edit.activityLevel,
    });
  }, [edit, remote]);

  const budget = remote?.budget ?? (localPreview.ok ? localPreview.result : null);
  const offline = profileQuery.isError;

  return (
    <section aria-labelledby="profile-title" className="space-y-5">
      <h1 id="profile-title" className="text-xl font-semibold text-slate-900 dark:text-slate-100">
        我的
      </h1>

      {/* 每日轻提醒（三期，最小实现：默认关闭、仅本地通知） */}
      <ReminderSettings />

      {offline && (
        <p role="status" className="rounded-xl bg-coral-50 px-4 py-2 text-xs text-coral-700 dark:bg-coral-900/30 dark:text-coral-200">
          {COPY.offlineNotice}
        </p>
      )}

      {budget !== null && (
        <div className="qsh-surface p-5 dark:ring-slate-700">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">当前热量预算</h2>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl bg-brand-50 p-3 dark:bg-brand-900/40">
              <dt className="text-xs text-slate-600 dark:text-slate-400">建议摄入</dt>
              <dd className="qsh-tnum mt-1 font-semibold text-brand-700 dark:text-brand-200">
                {toDisplayEnergy(budget.intakeRecommended, unit)} {energyLabel(unit)}
              </dd>
            </div>
            <div className="rounded-xl bg-brand-50 p-3 dark:bg-brand-900/40">
              <dt className="text-xs text-slate-600 dark:text-slate-400">BMR</dt>
              <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
                {toDisplayEnergy(budget.bmr, unit)}
              </dd>
            </div>
            <div className="rounded-xl bg-brand-50 p-3 dark:bg-brand-900/40">
              <dt className="text-xs text-slate-600 dark:text-slate-400">TDEE</dt>
              <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
                {toDisplayEnergy(budget.tdee, unit)}
              </dd>
            </div>
          </dl>
          {!offline && <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">数据来自服务端重算结果</p>}
          {offline && <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">当前展示为本地预览，联网后会自动更新</p>}
        </div>
      )}

      {budget !== null && (
        <SafetyBanner
          safetyMessages={'safetyMessages' in budget ? budget.safetyMessages : []}
          warnings={'warnings' in budget ? budget.warnings : []}
          floorApplied={'floorApplied' in budget ? Boolean(budget.floorApplied) : false}
          isDeficitCapped={'isDeficitCapped' in budget ? Boolean(budget.isDeficitCapped) : false}
        />
      )}

      {/* 我的目标编辑卡（AC-11.2.7）：引导问卷之后，用户仍可在这里改目标体重 / 期限。
          位置紧挨「当前热量预算」卡 —— 目标直接决定预算（缺口 = 每周目标减重），
          改完能立刻在相邻的预算卡上看到变化，因果最直观。
          「基础数据」（性别 / 身高 / 活动量，后端 PATCH /profile）与「目标」
          （体重 / 期限，后端 PATCH /goals）是两条独立路由、两套校验范围，故独立成卡、独立提交。 */}
      <GoalSettingsCard />

      {/* 基础数据修改 */}
      <form
        className="qsh-surface space-y-3 p-5 dark:ring-slate-700"
        onSubmit={(event) => {
          event.preventDefault();
          const heightCm = Number(edit.heightCm);
          if (!Number.isFinite(heightCm) || heightCm < 80 || heightCm > 250) {
            setNotice('身高填一个 80 到 250 之间的数字就好');
            return;
          }
          updateProfile.mutate({
            gender: edit.gender,
            birthDate: edit.birthDate,
            heightCm,
            activityLevel: edit.activityLevel,
          });
        }}
      >
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">基础数据</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm text-slate-600 dark:text-slate-300">
            性别
            <select
              value={edit.gender}
              onChange={(event) => setEdit((prev) => ({ ...prev, gender: event.target.value as Gender }))}
              className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="female">女</option>
              <option value="male">男</option>
            </select>
          </label>
          <label className="text-sm text-slate-600 dark:text-slate-300">
            出生日期
            <input
              type="date"
              max={todayKey()}
              value={edit.birthDate}
              onChange={(event) => setEdit((prev) => ({ ...prev, birthDate: event.target.value }))}
              className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          <label className="text-sm text-slate-600 dark:text-slate-300">
            身高（cm）
            <input
              inputMode="decimal"
              value={edit.heightCm}
              onChange={(event) => setEdit((prev) => ({ ...prev, heightCm: event.target.value }))}
              className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          <label className="text-sm text-slate-600 dark:text-slate-300">
            活动量
            <select
              value={edit.activityLevel}
              onChange={(event) =>
                setEdit((prev) => ({ ...prev, activityLevel: event.target.value as ActivityLevel }))
              }
              className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
              {ACTIVITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="submit"
          disabled={updateProfile.isPending}
          className="qsh-touch-target w-full rounded-xl bg-brand-600 py-3 font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          {updateProfile.isPending ? '正在重算…' : '保存并重新计算'}
        </button>
        {notice !== null && (
          <p role="status" aria-live="polite" className="text-sm text-brand-700 dark:text-brand-300">
            {notice}
          </p>
        )}
      </form>

      {/* 参考来源（R2.9 / TC-14） */}
      <section
        aria-label="参考来源"
        className="qsh-surface p-5 dark:ring-slate-700"
      >
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">参考来源</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">我们的数字都能溯源，欢迎核对。</p>
        <ul className="mt-3 space-y-3 text-sm text-slate-600 dark:text-slate-300">
          <li>
            <strong className="text-slate-800 dark:text-slate-100">Mifflin-St Jeor 公式（1990）</strong>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              基础代谢率（BMR）：男 = 10×体重(kg) + 6.25×身高(cm) − 5×年龄 + 5；女 = 同式 − 161。
            </p>
          </li>
          <li>
            <strong className="text-slate-800 dark:text-slate-100">WHO BMI 标准</strong>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              健康体重区间以 BMI 18.5–23.9 为参考，目标体重过轻时会给出温和提示。
            </p>
          </li>
          <li>
            <strong className="text-slate-800 dark:text-slate-100">成人活动 MET 汇编（2024）</strong>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              活动系数：久坐 1.2 / 轻度 1.375 / 中度 1.55 / 高强度 1.725 / 运动员 1.9。
            </p>
          </li>
        </ul>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          安全下限：女性 1200 kcal / 男性 1500 kcal；每日缺口不超过 TDEE 的 30%。
        </p>
      </section>

      {/* 数据管理入口 */}
      <Link
        to="/settings/data"
        className="qsh-touch-target block rounded-2xl bg-brand-600 px-5 py-3 text-center font-medium text-white"
      >
        数据导出 / 导入 / 删除
      </Link>

      {/* 我的食物库（C-4 第二步）：管理自己存进库的食物（改 / 删）。
          与「数据导出 / 导入 / 删除」同属「我的」范畴的设置类落点，故并排放在这里；
          用次级样式（brand-50/brand-700）与上面的主行动作区分层级。 */}
      <Link
        to="/settings/foods"
        className="qsh-touch-target block rounded-2xl bg-brand-50 px-5 py-3 text-center font-medium text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
      >
        我的食物库
      </Link>

      {/* 更多功能（导航兜底）—— 「我的」页是设置类信息的落点（见本页顶部注释），
          把不在底部导航里的页面集中列在这里，用户从任意位置出发都能找到它们。
          用「列表行 + 箭头」的次级样式（模式 B 的次级 Link），层级低于上面的主行动作；
          每条链接都是可读的文字（不是图标-only），满足无障碍要求。
          ⚠️ 断食计时列在最前 —— 它是断食功能的唯一开关入口，此前全站不可达。 */}
      <section
        aria-label={COPY.profileMoreTitle}
        className="qsh-surface p-5 dark:ring-slate-700"
      >
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
          {COPY.profileMoreTitle}
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{COPY.profileMoreDesc}</p>
        <ul className="mt-3 divide-y divide-brand-100 dark:divide-slate-700">
          {MORE_LINKS.map((link) => (
            <li key={link.to}>
              <Link
                to={link.to}
                className="qsh-touch-target flex items-center justify-between gap-3 py-3 font-medium text-brand-700 dark:text-brand-200"
              >
                <span>
                  {link.label}
                  {link.hint !== undefined && (
                    <span className="mt-0.5 block text-xs font-normal text-slate-500 dark:text-slate-400">
                      {link.hint}
                    </span>
                  )}
                </span>
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* 安装到桌面的一句静态说明（GAP-8 降级版）—— 零 JS：
          不做 `beforeinstallprompt` 弹窗、不做 iOS 图示引导、不做横幅/浮层。
          「我的」页是设置类信息的落点，比 `/settings/data`（数据管理）更贴近
          「这台设备怎么用」这类问题。 */}
      <section
        aria-label={COPY.installHintTitle}
        className="qsh-surface p-5 dark:ring-slate-700"
      >
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
          {COPY.installHintTitle}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {COPY.installHintBody}
        </p>
      </section>

      {/* 登录 / 账号 */}
      {accessToken === null ? (
        <LoginCard />
      ) : (
        <section
          aria-label="账号"
          className="qsh-surface p-5 dark:ring-slate-700"
        >
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">账号</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            已登录：{user?.email ?? '当前账号'}
          </p>
          <button
            type="button"
            onClick={() => {
              clear();
              setNotice('已经退出登录，随时可以再回来');
            }}
            className="qsh-touch-target mt-3 w-full rounded-xl py-3 text-sm text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
          >
            退出登录
          </button>
        </section>
      )}

      <p className="px-1 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
        {COPY.disclaimer}
      </p>
    </section>
  );
}
