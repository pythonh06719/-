import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ACTIVITY_FACTORS,
  DEFICIT_CAP_RATIO,
  KCAL_PER_G_CARB,
  KCAL_PER_G_FAT,
  KCAL_PER_G_PROTEIN,
  KCAL_PER_KG_FAT,
  SAFETY_FLOOR,
  TAPER_REMAINING_KG,
  ageFromBirthDate,
  buildSafetyMessages,
  round2,
  safeCalcCalorieBudget,
} from '@qsh/core';
import type { ActivityLevel, CalorieResult, Gender } from '@qsh/core';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth.store';
import { queryKeys } from '@/lib/queryClient';
// 本页正文多为内联字面量，但「读不到档案」的失败态**复用全站既有**的 `COPY.offlineNotice`
// （与 `HabitsPage` / `GoalSettingsCard` / `FastingPage` 同句），不另造一句。
import { COPY } from '@/lib/copy';
import { MEAL_BUDGET_SHARE } from '@/theme/tokens';
import { MEAL_TYPE_LABELS, MEAL_TYPE_ORDER } from '@/pages/diary/meal-utils';
import DerivationRow from '../DerivationRow';
import type { WhySectionProps } from './types';

/**
 * ① 热量预算怎么算（`/why-numbers` 第 1 条）。
 *
 * 这是 26 条里唯一「结构复杂到无法数据化」的一条：除推导行外还有
 * **活动系数表 / 每餐预算表 / 你的数字（实时算出）/ 安全网两道防线** 四块，
 * 且「你的数字」要吃 `/profile` 查询并就地重算 —— 查询因此跟着本条走
 * （全页只有这一块消费它，放在页面壳里反而是把状态提到用不到的地方）。
 *
 * 2026-10-12（P2-4 注册表化）：从 1549 行的 `WhyNumbersPage.tsx` 整体迁出，
 * JSX 逐字未改（重构前后有 innerHTML 对拍证据）。
 */

interface LiveProfile {
  gender: Gender;
  birthDate: string;
  heightCm: number;
  activityLevel: ActivityLevel;
}

interface LiveGoal {
  startWeightKg: number;
  targetWeightKg: number;
  targetWeeks: number;
}

/** `GET /api/profile` 的只读子集（字段宽松以容忍服务端附加字段）。 */
interface ProfileResult {
  profile: LiveProfile | null;
  goal: LiveGoal | null;
  budget: CalorieResult | null;
}

/** 活动水平中文名（展示用）。 */
const ACTIVITY_LABEL: Readonly<Record<ActivityLevel, string>> = {
  sedentary: '久坐（几乎不运动）',
  light: '轻度活动（每周 1–3 次）',
  moderate: '中度活动（每周 3–5 次）',
  high: '高强度（每周 6–7 次）',
  athlete: '运动员（每天高强度）',
};

export default function BudgetSection({ id, title }: WhySectionProps): ReactElement {
  // 未登录时**跳过** `/profile` 请求：避免 401 触发全局登出跳转，让本页在登出状态也可读（P3 收口）。
  const hasToken = getAccessToken() !== null;
  const profileQuery = useQuery({
    queryKey: queryKeys.profile,
    queryFn: () => api.get<ProfileResult>('/profile'),
    enabled: hasToken,
    retry: 0,
  });

  const data = profileQuery.data ?? null;

  /** 用用户档案 + 目标数据，复用 `@qsh/core` 实时算出预算与推导链（服务端同源公式，不重写）。 */
  const live = useMemo(() => {
    if (data === null || data.profile === null || data.goal === null) {
      return null;
    }
    const { profile, goal } = data;
    const age = ageFromBirthDate(profile.birthDate, new Date());
    const safe = safeCalcCalorieBudget({
      gender: profile.gender,
      age,
      heightCm: profile.heightCm,
      weightKg: goal.startWeightKg,
      targetWeightKg: goal.targetWeightKg,
      targetWeeks: goal.targetWeeks,
      activityLevel: profile.activityLevel,
    });
    if (!safe.ok) {
      return null;
    }
    return {
      age,
      activityFactor: ACTIVITY_FACTORS[profile.activityLevel],
      activityLabel: ACTIVITY_LABEL[profile.activityLevel],
      budget: safe.result,
      safeguardMessages: buildSafetyMessages({
        floorApplied: safe.result.floorApplied,
        isDeficitCapped: safe.result.isDeficitCapped,
      }),
    };
  }, [data]);

  return (
    <section
      aria-labelledby={id}
      className="qsh-surface p-5"
    >
      <h2 id={id} className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </h2>
      <p className="mt-tight text-sm text-slate-600 dark:text-slate-300">
        我们按一套公开公式一步步推，不是拍脑袋给一个数字。顺序是：BMR → 乘活动系数得 TDEE → 减去一个温和缺口 → 再套一层安全网。
      </p>

      <dl className="mt-block rounded-control bg-brand-50 p-4 dark:bg-brand-900/40">
        <DerivationRow term="BMR（基础代谢率）" value="Mifflin-St Jeor（1990）" />
        <DerivationRow term="男性" value="10×体重(kg) + 6.25×身高(cm) − 5×年龄 + 5" />
        <DerivationRow term="女性" value="10×体重(kg) + 6.25×身高(cm) − 5×年龄 − 161" />
        <DerivationRow term="TDEE（每日总消耗）" value="BMR × 活动系数" />
        <DerivationRow term="每日缺口" value="每周目标减重(kg) × 7700 ÷ 7" hint="7700 kcal ≈ 1kg 脂肪" />
        <DerivationRow term="建议摄入" value="TDEE − 有效缺口，且不低于安全下限" />
      </dl>

      <h3 className="mt-4 text-sm font-semibold text-slate-800 dark:text-slate-100">活动系数</h3>
      <table className="mt-2 w-full border-collapse text-sm">
        <caption className="sr-only">各活动水平对应的活动系数</caption>
        <thead>
          <tr className="text-left text-xs text-slate-600 dark:text-slate-300">
            <th scope="col" className="py-1 font-medium">活动水平</th>
            <th scope="col" className="py-1 text-right font-medium">系数</th>
          </tr>
        </thead>
        <tbody className="text-slate-700 dark:text-slate-200">
          {(Object.keys(ACTIVITY_FACTORS) as ActivityLevel[]).map((level) => (
            <tr key={level} className="border-t border-slate-100 dark:border-slate-700">
              <td className="py-1.5">{ACTIVITY_LABEL[level]}</td>
              <td className="qsh-tnum py-1.5 text-right font-medium">{ACTIVITY_FACTORS[level]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 实时分解：用用户档案数据算出「你的数字」 */}
      <h3 className="mt-5 text-sm font-semibold text-slate-800 dark:text-slate-100">你的数字（实时算出）</h3>
      {profileQuery.isError ? (
        // 失败专属区块：拿不到档案 ≠ 没做引导问卷。这一支必须排在 `live === null` 的
        // 兜底之前，否则已登录用户读不到数据时会被说成「完成引导问卷后」（P0，见测试）。
        // 形态与 `HabitsPage` / `GoalSettingsCard` 的「读不到」块一致；文案复用 `COPY.offlineNotice`。
        <div
          role="status"
          data-testid="why-numbers-profile-error"
          className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control bg-slate-100 px-4 py-2 text-body text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        >
          <span>{COPY.offlineNotice}</span>
          <button
            type="button"
            data-testid="why-numbers-profile-retry"
            className="qsh-touch-target rounded-control px-2 py-1 font-medium text-brand-700 underline underline-offset-2 transition-colors duration-qsh-base ease-qsh-out disabled:opacity-60 dark:text-brand-300"
            disabled={profileQuery.isFetching}
            onClick={() => {
              void profileQuery.refetch();
            }}
          >
            重新试试
          </button>
        </div>
      ) : live !== null ? (
        <dl className="mt-2 rounded-control bg-slate-50 p-4 dark:bg-slate-700">
          <DerivationRow term="你的年龄" value={`${live.age} 岁`} />
          <DerivationRow term="当前体重" value={`${data?.goal?.startWeightKg ?? '—'} kg`} />
          <DerivationRow term="BMR（基础代谢）" value={`${live.budget.bmr} kcal`} />
          <DerivationRow term="活动系数" value={`${live.activityFactor}`} hint={live.activityLabel} />
          <DerivationRow term="TDEE（每日总消耗）" value={`${live.budget.tdee} kcal`} />
          {/*
            取 core 的 `weeklyLossKg`（taper **后**），与下一行「原始缺口」同源：
            本地用 `deriveWeeklyLossKg` 重算只能得到 taper 前的 base 速度，收尾阶段会出现
            「0.15 kg/周」配「123.7 kcal/日」这种乘不出彼此的自相矛盾（NFR-11）。
            core 该字段已是 `round2`（`types.ts` 明确它是喂进 `targetDeficitRaw` 的那个值），
            此处再过一次 `round2` 只为替代原先手写的 `Math.round(x*100)/100`，幂等。
          */}
          <DerivationRow
            term="每周目标减重"
            value={`${round2(live.budget.weeklyLossKg)} kg/周`}
            hint={live.budget.taperApplied ? `距目标不足 ${TAPER_REMAINING_KG} kg，已自动放缓` : ''}
          />
          <DerivationRow term="原始缺口" value={`${live.budget.targetDeficitRaw} kcal/日`} />
          <DerivationRow
            term="缺口上限（TDEE×30%）"
            value={`${live.budget.deficitCap} kcal/日`}
            hint={live.budget.isDeficitCapped ? '已触发，已按上限收窄' : ''}
          />
          <DerivationRow term="有效缺口" value={`${live.budget.effectiveDeficit} kcal/日`} />
          <DerivationRow
            term="安全下限"
            value={`${live.budget.safetyFloor} kcal/日`}
            hint={live.budget.floorApplied ? '已触发，建议摄入守住下限' : ''}
          />
          <DerivationRow term="建议摄入" value={`${live.budget.intakeRecommended} kcal/日`} />
        </dl>
      ) : (
        <p className="mt-2 rounded-control bg-slate-50 p-4 text-sm text-slate-600 dark:bg-slate-700 dark:text-slate-300">
          {hasToken
            ? '完成引导问卷后，这里会用你自己的资料实时算出每一步的分解。'
            : '登录并完成引导问卷后，这里会用你自己的资料实时算出每一步的分解。'}
        </p>
      )}

      {live !== null && live.safeguardMessages.length > 0 && (
        <ul className="mt-block space-y-2">
          {live.safeguardMessages.map((message) => (
            <li
              key={message}
              className="rounded-control border border-brand-100 bg-white px-4 py-2 text-sm text-brand-700 dark:border-slate-700 dark:bg-slate-800 dark:text-brand-200"
            >
              {message}
            </li>
          ))}
        </ul>
      )}

      {/* 每餐参考预算（R3.8 / B5）—— 取值来源改为服务端权威后，解释同步补齐（NFR-11） */}
      <h3 className="mt-5 text-sm font-semibold text-slate-800 dark:text-slate-100">
        每餐参考预算怎么分
      </h3>
      <p className="mt-tight text-sm text-slate-600 dark:text-slate-300">
        饮食页每一餐后面那句「参考 N kcal」=
        <strong className="font-semibold">每日建议摄入 × 这一餐的占比</strong>
        ，没有第二套算法。每日建议摄入取自服务端按你的资料重算的结果（本机缓存只在断网时兜底），
        所以清掉缓存、换了手机、第一次打开也都还在。
      </p>
      <table className="mt-2 w-full border-collapse text-sm">
        <caption className="sr-only">各餐次占每日预算的比例</caption>
        <thead>
          <tr className="text-left text-xs text-slate-600 dark:text-slate-300">
            <th scope="col" className="py-1 font-medium">餐次</th>
            <th scope="col" className="py-1 text-right font-medium">占每日预算</th>
          </tr>
        </thead>
        <tbody className="text-slate-700 dark:text-slate-200">
          {MEAL_TYPE_ORDER.map((mealType) => (
            <tr key={mealType} className="border-t border-slate-100 dark:border-slate-700">
              <td className="py-1.5">{MEAL_TYPE_LABELS[mealType]}</td>
              <td className="qsh-tnum py-1.5 text-right font-medium">
                {Math.round(MEAL_BUDGET_SHARE[mealType] * 100)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
        这只是帮你把一天分一分的参考，不是给每一顿打的分数 —— 一顿多吃一点、下一顿少一点，都正常。
      </p>

      <h3 className="mt-5 text-sm font-semibold text-slate-800 dark:text-slate-100">
        安全网：两道防线
      </h3>
      <ul className="mt-2 space-y-2 text-sm text-slate-600 dark:text-slate-300">
        <li className="rounded-control bg-amber-50 px-4 py-3 dark:bg-amber-900/30">
          <strong className="text-amber-800 dark:text-amber-200">缺口上限 = TDEE × {DEFICIT_CAP_RATIO}（30%）</strong>
          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-100">
            当你想「更快一点」导致缺口超过 TDEE 的 30% 时，我们会把你拉回这个上限 —— 目标会温和一些，但更容易坚持。
          </p>
        </li>
        <li className="rounded-control bg-amber-50 px-4 py-3 dark:bg-amber-900/30">
          <strong className="text-amber-800 dark:text-amber-200">
            安全下限 = 女性 {SAFETY_FLOOR.female} / 男性 {SAFETY_FLOOR.male} kcal
          </strong>
          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-100">
            无论缺口怎么算，建议摄入都不会低于这条线。
            <strong className="font-semibold">下限优先级高于缺口上限</strong>，两道防线可同时生效。
          </p>
        </li>
      </ul>
      <p className="mt-block text-sm text-slate-600 dark:text-slate-300">
        参考也可以：宏量营养素按能量的 {KCAL_PER_G_PROTEIN} kcal/g（蛋白）、{KCAL_PER_G_FAT} kcal/g（脂肪）、
        {KCAL_PER_G_CARB} kcal/g（碳水）折算；1kg 脂肪约 {KCAL_PER_KG_FAT} kcal。
      </p>
    </section>
  );
}
