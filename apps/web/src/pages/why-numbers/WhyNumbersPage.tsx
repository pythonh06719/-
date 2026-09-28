import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ACTIVITY_FACTORS,
  AI_DAILY_LIMIT,
  DEFICIT_CAP_RATIO,
  KCAL_PER_G_CARB,
  KCAL_PER_G_FAT,
  KCAL_PER_G_PROTEIN,
  KCAL_PER_KG_FAT,
  MET_ACTIVITY_LIBRARY,
  PLATEAU_MIN_POINTS,
  PLATEAU_STALE_DAYS,
  PLATEAU_THRESHOLD_KG,
  PLATEAU_WINDOW_DAYS,
  SAFETY_FLOOR,
  SLOPE_WINDOW_DAYS,
  TAPER_REMAINING_KG,
  TOOL_MEMORY_LIMITS,
  ageFromBirthDate,
  buildSafetyMessages,
  deriveWeeklyLossKg,
  safeCalcCalorieBudget,
} from '@qsh/core';
import type { ActivityLevel, CalorieResult, Gender } from '@qsh/core';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth.store';
import { queryKeys } from '@/lib/queryClient';
import { MEAL_BUDGET_SHARE } from '@/theme/tokens';
import { MEAL_TYPE_LABELS, MEAL_TYPE_ORDER } from '@/pages/diary/meal-utils';

/**
 * 数字是怎么来的（`/why-numbers`，可解释性 / 透明度页）。
 *
 * 目的：把「这些数字是怎么算出来的」做成 App 内可查 —— 与「可溯源、无负罪感」定位一致。
 * 四个内容块：
 *   ① 热量预算怎么算（BMR → 活动系数 → TDEE → 缺口 → 安全下限/缺口上限）
 *   ② 运动消耗怎么算（MET 公式）
 *   ③ 数据来源与许可（食物库来源 + 单位说明）
 *   ④ 我们的取舍（为什么不用红色警示 / 不做极端目标 / 数字只是参考）
 *
 * **同源真源**：所有公式与活动系数均来自 `@qsh/core`（前后端唯一真源），
 * 页面用用户档案数据实时算出 BMR/TDEE 并展示分解（只读 `/profile` 接口，取数不可用时优雅降级为纯说明）。
 * 无障碍：语义化 section/h2 + dl/table；语气遵循 PRD §7（鼓励式、无负罪感）。
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
  weeklyLossKg: number;
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

/** MET 示例：取前若干个内置运动，按 60kg / 30 分钟展示换算（复用 core 的 MET 表）。 */
const MET_SAMPLES = MET_ACTIVITY_LIBRARY.slice(0, 5).map((item) => ({
  name: item.name,
  met: item.met,
  kcalFor30minAt60kg: Math.round(item.met * 60 * 0.5),
}));

/** 「公式示例」用内置「快走」实测值，保证与 MET 表一致（不写死可能漂移的数字）。 */
const MET_EXAMPLE = (() => {
  const brisk = MET_ACTIVITY_LIBRARY.find((item) => item.code === 'walking_brisk');
  const met = brisk?.met ?? 5;
  return { met, kcalFor30minAt60kg: Math.round(met * 60 * 0.5) };
})();

/** 一个「术语 → 数值」的定义行。 */
function DerivationRow({
  term,
  value,
  hint,
}: {
  term: string;
  value: string;
  hint?: string;
}): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-2 last:border-b-0 dark:border-slate-700">
      <dt className="text-sm text-slate-600 dark:text-slate-300">
        {term}
        {hint !== undefined && (
          <span className="ml-2 text-xs text-slate-600 dark:text-slate-300">{hint}</span>
        )}
      </dt>
      <dd className="qsh-tnum shrink-0 text-sm font-semibold text-slate-800 dark:text-slate-100">{value}</dd>
    </div>
  );
}

export default function WhyNumbersPage(): ReactElement {
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
    const weeklyLossKg = deriveWeeklyLossKg(goal.startWeightKg, goal.targetWeightKg, goal.targetWeeks);
    return {
      age,
      weeklyLossKg,
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
    <section aria-labelledby="why-numbers-title" className="space-y-5">
      <header className="space-y-1">
        <h1 id="why-numbers-title" className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          数字是怎么来的
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          这里的每一个数字都有出处。把「怎么算的」摊开讲清楚，你才好判断要不要信、要不要照着来。
        </p>
      </header>

      {/* ① 热量预算怎么算 */}
      <section
        aria-labelledby="why-budget-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="why-budget-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ① 热量预算怎么算
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          我们按一套公开公式一步步推，不是拍脑袋给一个数字。顺序是：BMR → 乘活动系数得 TDEE → 减去一个温和缺口 → 再套一层安全网。
        </p>

        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow term="BMR（基础代谢率）" value="Mifflin-St Jeor（1990）" />
          <DerivationRow term="男性" value="10×体重(kg) + 6.25×身高(cm) − 5×年龄 + 5" />
          <DerivationRow term="女性" value="10×体重(kg) + 6.25×身高(cm) − 5×年龄 − 161" />
          <DerivationRow term="TDEE（每日总消耗）" value="BMR × 活动系数" />
          <DerivationRow term="每日缺口" value="每周目标减重(kg) × 7700 ÷ 7" hint={`7700 kcal ≈ 1kg 脂肪`} />
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
        {live !== null ? (
          <dl className="mt-2 rounded-xl bg-slate-50 p-4 dark:bg-slate-700">
            <DerivationRow term="你的年龄" value={`${live.age} 岁`} />
            <DerivationRow term="当前体重" value={`${data?.goal?.startWeightKg ?? '—'} kg`} />
            <DerivationRow term="BMR（基础代谢）" value={`${live.budget.bmr} kcal`} />
            <DerivationRow term="活动系数" value={`${live.activityFactor}`} hint={live.activityLabel} />
            <DerivationRow term="TDEE（每日总消耗）" value={`${live.budget.tdee} kcal`} />
            <DerivationRow term="每周目标减重" value={`${Math.round(live.weeklyLossKg * 100) / 100} kg/周`} />
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
          <p className="mt-2 rounded-xl bg-slate-50 p-4 text-sm text-slate-600 dark:bg-slate-700 dark:text-slate-300">
            {hasToken
              ? '完成引导问卷后，这里会用你自己的资料实时算出每一步的分解。'
              : '登录并完成引导问卷后，这里会用你自己的资料实时算出每一步的分解。'}
          </p>
        )}

        {live !== null && live.safeguardMessages.length > 0 && (
          <ul className="mt-3 space-y-2">
            {live.safeguardMessages.map((message) => (
              <li
                key={message}
                className="rounded-xl border border-brand-100 bg-white px-4 py-2 text-sm text-brand-700 dark:border-slate-700 dark:bg-slate-800 dark:text-brand-200"
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
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
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
          <li className="rounded-xl bg-amber-50 px-4 py-3 dark:bg-amber-900/30">
            <strong className="text-amber-800 dark:text-amber-200">缺口上限 = TDEE × {DEFICIT_CAP_RATIO}（30%）</strong>
            <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-100">
              当你想「更快一点」导致缺口超过 TDEE 的 30% 时，我们会把你拉回这个上限 —— 目标会温和一些，但更容易坚持。
            </p>
          </li>
          <li className="rounded-xl bg-amber-50 px-4 py-3 dark:bg-amber-900/30">
            <strong className="text-amber-800 dark:text-amber-200">
              安全下限 = 女性 {SAFETY_FLOOR.female} / 男性 {SAFETY_FLOOR.male} kcal
            </strong>
            <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-100">
              无论缺口怎么算，建议摄入都不会低于这条线。
              <strong className="font-semibold">下限优先级高于缺口上限</strong>，两道防线可同时生效。
            </p>
          </li>
        </ul>
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          参考也可以：宏量营养素按能量的 {KCAL_PER_G_PROTEIN} kcal/g（蛋白）、{KCAL_PER_G_FAT} kcal/g（脂肪）、
          {KCAL_PER_G_CARB} kcal/g（碳水）折算；1kg 脂肪约 {KCAL_PER_KG_FAT} kcal。
        </p>
      </section>

      {/* ② 运动消耗怎么算 */}
      <section
        aria-labelledby="why-exercise-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="why-exercise-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ② 运动消耗怎么算
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          用运动医学通用的 MET 公式（MET = 代谢当量），数值来自《2024 成人活动 MET 汇编》，与后端是同一份表。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow term="公式" value="kcal = MET × 体重(kg) × 时长(小时)" />
          <DerivationRow
            term="示例"
            value={`快走 MET ${MET_EXAMPLE.met} × 60kg × 0.5h ≈ ${MET_EXAMPLE.kcalFor30minAt60kg} kcal`}
          />
        </dl>
        <table className="mt-3 w-full border-collapse text-sm">
          <caption className="sr-only">常见运动的 MET 值与换算示例（60kg / 30 分钟）</caption>
          <thead>
            <tr className="text-left text-xs text-slate-600 dark:text-slate-300">
              <th scope="col" className="py-1 font-medium">运动</th>
              <th scope="col" className="py-1 text-right font-medium">MET</th>
              <th scope="col" className="py-1 text-right font-medium">约消耗（60kg / 30 分钟）</th>
            </tr>
          </thead>
          <tbody className="text-slate-700 dark:text-slate-200">
            {MET_SAMPLES.map((item) => (
              <tr key={item.name} className="border-t border-slate-100 dark:border-slate-700">
                <td className="py-1.5">{item.name}</td>
                <td className="qsh-tnum py-1.5 text-right">{item.met}</td>
                <td className="qsh-tnum py-1.5 text-right">{item.kcalFor30minAt60kg} kcal</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">
          运动消耗是估算值：实际还受强度、效率、体质影响，所以我们会说「大约」。别把它当精确账本。
        </p>
      </section>

      {/* ③ 数据来源与许可 */}
      <section
        aria-labelledby="why-data-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="why-data-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ③ 数据来源与许可
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          食物库共 1773 条，逐条标注来源与许可；代码为 MIT，数据是混合来源（详见仓库 DATA-LICENSE.md）。
          其中《中国食物成分表》扩量条目仅限个人非商业自用，不参与对外分发。
        </p>
        <table className="mt-3 w-full border-collapse text-sm">
          <caption className="sr-only">食物营养数据来源与许可</caption>
          <thead>
            <tr className="text-left text-xs text-slate-600 dark:text-slate-300">
              <th scope="col" className="py-1 font-medium">来源</th>
              <th scope="col" className="py-1 text-right font-medium">条数</th>
              <th scope="col" className="py-1 font-medium">许可</th>
            </tr>
          </thead>
          <tbody className="text-slate-700 dark:text-slate-200">
            <tr className="border-t border-slate-100 dark:border-slate-700">
              <td className="py-1.5">本项目自建（依《中国食物成分表》等公开资料整理）</td>
              <td className="qsh-tnum py-1.5 text-right">57</td>
              <td className="py-1.5">CC BY 4.0</td>
            </tr>
            <tr className="border-t border-slate-100 dark:border-slate-700">
              <td className="py-1.5">Open Food Facts（包装食品）</td>
              <td className="qsh-tnum py-1.5 text-right">258</td>
              <td className="py-1.5">ODbL 1.0（须署名）</td>
            </tr>
            <tr className="border-t border-slate-100 dark:border-slate-700">
              <td className="py-1.5">USDA FoodData Central（SR Legacy，中文译名与归类由本项目完成）</td>
              <td className="qsh-tnum py-1.5 text-right">128</td>
              <td className="py-1.5">公有领域</td>
            </tr>
            <tr className="border-t border-slate-100 dark:border-slate-700">
              <td className="py-1.5">《中国食物成分表》（个人非商业自用，不参与对外分发）</td>
              <td className="qsh-tnum py-1.5 text-right">1330</td>
              <td className="py-1.5">个人非商业自用</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">
          署名：© Open Food Facts contributors（ODbL 1.0）；USDA FoodData Central — SR Legacy（公有领域）。
          《中国食物成分表》数据未经中国营养学会/中国疾控中心营养与健康所书面允许不得用于商业目的，本项目仅个人非商业自用、不再分发。
        </p>

        <h3 className="mt-4 text-sm font-semibold text-slate-800 dark:text-slate-100">单位说明</h3>
        <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">
          <li>热量默认用 <strong className="text-slate-800 dark:text-slate-100">kcal（千卡）</strong>：1 kcal ≈ 4.184 kJ。</li>
          <li>顶栏可切换 kcal / kJ，换算只影响显示，不改变底层数据。</li>
          <li>食物营养一律按「每 100 克」记录，克数换算为 每100g 数值 × 克数 ÷ 100。</li>
          <li>饮水按毫升（ml），体重按千克（kg），运动时长按分钟。</li>
        </ul>
      </section>

      {/* ④ 我们的取舍 */}
      <section
        aria-labelledby="why-choice-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="why-choice-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ④ 我们的取舍
        </h2>
        <dl className="mt-2 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么不用红色警示</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              刺眼的红色和评判性的字眼会让人紧张，而紧张很少带来好习惯。我们改用温和的品牌色与暖色做中性提醒，
              把注意力放在「接下来做什么」，而不是盯着数字评判自己。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么不做极端目标</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              极低热量和过快的减重很难维持，也容易伤身体。所以我们设了缺口上限与安全下限，
              宁可慢一点，也要能长期走下去。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么数字只是参考</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              公式是人群平均，你的身体是具体的人。数字用来帮你看趋势、做取舍，不是用来评判你今天够不够好。
              记录本身就是照顾自己。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          本页数字为健康生活参考，不构成医疗建议。孕期 / 哺乳期 / 疾病治疗期请咨询专业医师。
        </p>
      </section>

      {/* ⑤ 目标进度与维持模式（R2.7） */}
      <section
        aria-labelledby="why-goal-progress-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="why-goal-progress-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑤ 目标进度与维持模式怎么判断
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          体重页那个环只回答两件事：你走到哪儿了，大概还要多久。算不出来的时候，我们宁可整张卡片不显示，
          也不给你一个假数字。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow term="进度基准" value="目标历史里最早一条的起始体重" hint="= 设定目标时的体重" />
          <DerivationRow term="达成比" value="(基准 − 最新) ÷ (基准 − 目标)" hint="钳制到 0~100%" />
          <DerivationRow
            term="为什么不用「当前起始体重」"
            value="它会被「记录体重」同步成最新体重"
            hint="当基准会让进度恒为 0%"
          />
          <DerivationRow term="还需几周" value="引擎 etaWeeks = 剩余(kg) ÷ 每周有效减重" hint="展示时向上取整" />
          <DerivationRow term="维持模式" value="最新体重 ≤ 目标体重 → 不再制造缺口" hint="摄入回到 TDEE" />
        </dl>
        <ul className="mt-3 space-y-2 text-sm text-slate-600 dark:text-slate-300">
          <li className="rounded-xl bg-brand-50 px-4 py-3 dark:bg-brand-900/30">
            <strong className="text-brand-800 dark:text-brand-200">到了目标之后，我们不再催你往下走</strong>
            <p className="mt-0.5 text-xs text-brand-700 dark:text-brand-100">
              达成目标后，引擎会把缺口收敛到 0、建议摄入回到 TDEE，页面也切换成「已经到啦 + 维持热量」，
              不再显示「还需几周」。继续压低热量，不是我们推荐的做法。
            </p>
          </li>
          <li className="rounded-xl bg-brand-50 px-4 py-3 dark:bg-brand-900/30">
            <strong className="text-brand-800 dark:text-brand-200">算不出来的时候，就整张卡片不显示</strong>
            <p className="mt-0.5 text-xs text-brand-700 dark:text-brand-100">
              没有生效目标、或资料不足以重算预算时，进度卡不会出现 ——
              与其显示一个 0% 的空档让人对着发呆，不如什么都不说。
            </p>
          </li>
        </ul>
      </section>

      {/* ⑥ 平台期怎么看（R2.7） */}
      <section
        aria-labelledby="why-plateau-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="why-plateau-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑥ 平台期是怎么判断的
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          连着几周体重不动，很容易让人以为「白坚持了」。所以我们在体重页会主动解释一句，
          并把视角从每天的数字拉到 4 周。下面是判定规则 —— 全部来自 @qsh/core
          的纯函数，前后端同源。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow
            term="观察窗口"
            value={`${PLATEAU_WINDOW_DAYS} 天（3 周）`}
            hint="短于这个跨度不算平台期"
          />
          <DerivationRow
            term="变化阈值"
            value={`7 日均线变化 < ${PLATEAU_THRESHOLD_KG} kg`}
            hint="小于日常水分/食物的波动幅度"
          />
          <DerivationRow
            term="最少记录日"
            value={`${PLATEAU_MIN_POINTS} 个`}
            hint="少于此分不清「没变」和「没记」"
          />
          <DerivationRow
            term="停更保护"
            value={`最后一条距今 > ${PLATEAU_STALE_DAYS} 天则不判定`}
            hint="那是没在记录，不是平台期"
          />
          <DerivationRow
            term="4 周斜率"
            value={`最近 ${SLOPE_WINDOW_DAYS} 天最小二乘回归 × 7`}
            hint="单位 kg/周"
          />
        </dl>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么用 7 日均线，而不是每天的数字</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              每天上下浮动 0.5~1.5 kg 是常态（水分、食物重量、作息都会推着它动）。
              用 7 日平均可以把这类噪声抹平，看到的才是趋势本身。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么不因此建议你加大缺口</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              几周不动更常见的解释是身体适应与日常波动，而不是「吃得还不够少」。
              再压一点很难长期维持，所以我们的建议是把尺度拉长、把节奏稳住。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          平台期判定是生活参考，不构成医疗建议。如果体重长期异常变化，建议咨询专业医师。
        </p>
      </section>

      {/* ⑦ 体重区间怎么统计（C4） */}
      <section
        aria-labelledby="why-weight-range-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="why-weight-range-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑦ 体重区间（近 7 / 30 / 90 天）怎么统计
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          体重页可以切换看最近 7 / 30 / 90 天。换区间只是换看哪一段，取数方式没变，也不会改动你的任何记录 ——
          下面的「最低 / 最高 / 均值 / 净变化」跟着你选的区间一起变。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow term="区间窗口" value="[今天 − (N−1) 天, 今天]" hint="闭区间，含今天" />
          <DerivationRow term="最低 / 最高" value="窗口内记录的最小 / 最大体重" />
          <DerivationRow term="均值" value="窗口内所有记录的算术平均" hint="与 7 日均线不是一回事" />
          <DerivationRow term="净变化" value="窗口内最后 − 最早（可正可负）" />
          <DerivationRow
            term="7 日均线"
            value="每个记录日往前 7 个自然日窗口内取平均"
            hint="窗口跨区间边界时仍用区间外的历史"
          />
        </dl>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么默认给你看 90 天</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              默认选最宽的一段，是为了尽量把记录都摊在你眼前 —— 想聚焦近况再切到 7 / 30 天就好。
              换区间不改动任何数据，只是换个看的角度。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么切了区间，平台期说明还在</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              平台期判定看的是最近几周的整体情况，与图表正在显示哪一段无关，所以它始终用你的全部记录来算 ——
              这样不会因为你把区间切到 7 天，就误以为「平台期消失了」。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          区间统计只是帮你看清某一段的记录，不构成医疗建议。体重长期异常变化请咨询专业医师。
        </p>
      </section>

      {/* ⑧ 周报里的对比与达成率怎么读（C2） */}
      <section
        aria-labelledby="why-weekly-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="why-weekly-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑧ 周报里的对比与达成率怎么读
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          周报里新增了一张「摄入 vs 运动」对比图和一行习惯达成率。它们的口径都写在下面 ——
          数字只是把这一周发生的事摊开，不给你打分。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow term="摄入 vs 运动 柱高" value="按 7 天单日峰值统一缩放" hint="两组同一尺度，可直接目视对比" />
          <DerivationRow term="摄入合计" value="一周内所有饮食记录热量之和" />
          <DerivationRow term="运动合计" value="一周内所有运动记录消耗之和" />
          <DerivationRow
            term="习惯达成率"
            value="一周累计打卡次数 ÷ (7 天 × 每日习惯数)"
            hint="没有习惯时不显示 0%，改给一句引导"
          />
          <DerivationRow term="体重变化" value="本周内最后一条 − 最早一条" hint="不足两条记录则不给数字" />
        </dl>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么运动那根柱总比摄入矮</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              这是事实：日常运动消耗通常远小于一天的摄入，靠运动「抵消」吃进去的热量并不现实。
              我们照实画出来，是希望你据此安排节奏，而不是把运动当成惩罚。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么体重涨了也不标红</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              一周的体重变化会被水分、食物重量、作息推着走。我们只做中性陈述，把判断留给你和趋势本身 ——
              涨一点不代表这周白过。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          周报为健康生活参考，不构成医疗建议。数值异常或身体不适时请咨询专业医师。
        </p>
      </section>

      {/* ⑨ taper（R2.7）：新增的「速度自动放慢」必须可解释（NFR-11） */}
      <section
        aria-labelledby="why-taper-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="why-taper-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑨ 快到目标时，为什么建议会自动变宽松
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          离目标只剩一点点时，你会看到建议摄入悄悄变高（缺口变小）。这不是算错了，而是刻意的收尾设计 ——
          规则和理由都在下面。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow
            term="触发条件"
            value={`剩余需减 ≤ ${TAPER_REMAINING_KG} kg`}
            hint="剩余 = 当前体重 − 目标体重"
          />
          <DerivationRow
            term="收窄系数"
            value={`剩余量 ÷ ${TAPER_REMAINING_KG}`}
            hint="剩 1kg → 速度减半；剩 0.5kg → 剩四分之一"
          />
          <DerivationRow
            term="已达成时"
            value="不收窄，转为维持"
            hint="缺口归零、摄入回到 TDEE（见 ⑤）"
          />
        </dl>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么要放慢</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              最后几公斤若还维持大缺口，一旦达标骤然恢复饮食，身体很容易反弹。提前把速度线性降到 0，
              是给身体一个过渡 —— 慢一点到，比快一点到又弹回去要好。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么是 2 公斤</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              大约相当于温和节奏下的 2~4 周量，足够平缓又不至于拖太久；而且这时体重的日常波动（±0.5~1.5kg）
              已经和剩下的目标差不多了，再盯着大缺口也没有意义。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">它会不会动到安全底线</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              不会。收窄只改「减重速度」这一项，后面的 30% 缺口上限与安全下限照旧生效、优先级也不变 ——
              所以放慢只会让建议更宽松，绝不会让你吃得更少。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          阈值取自引擎常量 <span className="font-mono">TAPER_REMAINING_KG</span>
          ，本页直接从 @qsh/core 引入，不会与算法本身脱节。
        </p>
      </section>

      {/* ⑩ 餐次顺序（R3.8）：新增的「顺序」必须可解释（NFR-11） */}
      <section
        aria-labelledby="why-meal-order-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="why-meal-order-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑩ 餐次里的顺序是怎么定的
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          一餐里的条目可以按你实际吃的顺序排，也能整条挪到别的餐。
          顺序只是「摆放位置」，规则都在下面。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow
            term="存在哪儿"
            value="sort_order（0 开始的小整数）"
            hint="一餐内从 0 排到 n-1"
          />
          <DerivationRow
            term="新增记录排在哪"
            value="本餐当前最大值 + 1"
            hint="新记的一条总是排在最后，不会插到最前面"
          />
          <DerivationRow
            term="读取时的排序"
            value="sortOrder 升序，再按 id 升序"
            hint="顺序完全确定，不会因为刷新而跳动"
          />
          <DerivationRow
            term="拖动 / 上移 / 下移 / 移到某餐"
            value="只改 meal_type 与 sort_order"
            hint="四种操作走同一条接口"
          />
          <DerivationRow
            term="移动会不会改热量"
            value="不会"
            hint="kcal / 蛋白质 / 脂肪 / 碳水一律不变、不重算"
          />
          <DerivationRow
            term="以谁为准"
            value="服务端顺序"
            hint="前端先乐观更新，重新拉取后一律以服务端为准"
          />
        </dl>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么拖来拖去不会改变热量</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              顺序是「你记得的先后」，热量是「那一条记了多少」。把番茄炒蛋从午餐挪到加餐，
              它还是那条番茄炒蛋 —— 我们只是把它换个位置摆，不去重新算它。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么不用拖动也能完成同样的操作</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              长按拖动在触屏和读屏上不一定顺手，所以每条都另配了「上移 / 下移 / 移动到某餐」三个按钮，
              效果和拖动完全一样。拖动只是一个可选项，不是唯一办法。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          顺序只影响展示的先后，不影响任何热量、营养与预算数字 —— 也不参与任何评价。
        </p>
      </section>

      {/* ⑪ 常吃榜（R11.5） */}
      <section
        aria-labelledby="why-top-foods-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="why-top-foods-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑪ 常吃榜是怎么排出来的
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          「你常吃的」是你自己记出来的结果：不猜、不推荐、不评价，只把你这段时间出现得最多的几样列出来。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow term="时间窗" value="近 90 天，含今天" />
          <DerivationRow
            term="怎么算「同一种」"
            value="归一化显示名称优先"
            hint="名称缺失时回落食物库 id；库内条目与同名快加条目合并为同一种"
          />
          <DerivationRow
            term="计数口径"
            value="出现天数，不是出现次数"
            hint="同一天记两次只算 1 天 —— 「常」说的是日子"
          />
          <DerivationRow term="最低门槛" value="出现 ≥ 3 天" hint="不足 3 天整块不显示" />
          <DerivationRow term="展示上限" value="12 条" />
          <DerivationRow term="并列时怎么排" value="最近出现过的排在前面" hint="再并列按名称定序，结果不会跳动" />
          <DerivationRow term="排序依据" value="只有频次" hint="不含热量、不含营养素、不含任何健康度" />
        </dl>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么算「天数」而不是「次数」</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              一天里喝了两次牛奶，说「喝过 2 次」听起来多，说「有 1 天喝了」才是它真实的日常程度。
              我们要描述的是「它在你生活里出现的日子有多密」，不是那一条记了几次。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么不给它配任何评价</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              排名只按频次 —— 它不代表营养、不代表健康，也不是一份「该少吃什么」的清单。
              榜上出现奶茶只是说明你这阵子常喝，仅此而已。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          榜单只陈述频次，不评判食物，也不参与任何热量或目标的判断。
        </p>
      </section>

      {/* ⑫ 备份提醒与记录概览（R11.6） */}
      <section
        aria-labelledby="why-backup-title"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 id="why-backup-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑫ 备份提醒与记录概览
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          「多久没备份」和「我到底记了多少」这两个数字，口径都在下面 ——
          它们只是陈述，不是催你做事。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow
            term="上次备份存在哪儿"
            value="本机 localStorage 的 lastBackupAt"
            hint="一个时间戳，不上传、不参与账号数据"
          />
          <DerivationRow
            term="天数怎么算"
            value="先按本地时区折成日期键，再算日历差"
            hint="不直接截 ISO 的 UTC 日期部分，否则「今天备份」会被误判成「昨天」"
          />
          <DerivationRow term="提示阈值" value="≥ 30 天出现一行，≥ 90 天换一档说法" hint="< 30 天不提示" />
          <DerivationRow term="提示出现在哪" value="只在「数据管理」页的备份区块里" hint="不弹窗、不推送、不定时触发" />
          <DerivationRow
            term="记录概览的条数"
            value="各表的行数"
            hint="体重 / 餐次条目 / 运动 / 习惯打卡 / 饮水"
          />
          <DerivationRow term="记录概览的跨度" value="最早与最晚的记录日期" hint="某项一条都没有时整行隐藏" />
          <DerivationRow term="备份文件去哪了" value="只在本机生成一个文件" hint="不上传任何地方" />
        </dl>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么不做定时提醒</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              备份是你想起来的事，不是我们替你安排的事。所以只有你打开「数据管理」页时才会看到那一行 ——
              没有弹窗、没有通知、没有后台任务，也不会在你没打开应用的时候冒出来。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么不做「异常记录」检测</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              「异常」本身就是一个评判 —— 它暗示你的记录错了。而定义什么叫异常需要阈值，
              任何阈值都会变成你看不见的隐性标准。所以这里只陈述事实：记了多少条、跨度多久，
              至于哪条记录对不对，判断权留给你。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          备份全程只在本机生成文件，不经过任何第三方；记录概览只做陈述，不做任何异常判定。
        </p>
      </section>

      {/* ⑬ 阶段回顾的六个数字怎么来（R11.3，T03 同批交付） */}
      <section aria-labelledby="why-period-title" className="qsh-surface rounded-2xl p-5">
        <h2 id="why-period-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑬「这段时间」里的六个数字怎么来
        </h2>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow term="有记录的天数" value="当日体重 / 饮食 / 运动 / 习惯 / 饮水 / 这句话，任一有记录即计数" hint="区间含今天" />
          <DerivationRow term="食物种类数" value="与周报是同一个函数（distinctFoodKeys）" hint="归一化显示名优先" />
          <DerivationRow term="餐次条目" value="饮食记录的行数" />
          <DerivationRow term="记到最多的习惯" value="按完成的那次打卡计数" hint="并列时最多展示 2 个" />
          <DerivationRow term="运动" value="次数与时长求和" />
          <DerivationRow
            term="体重变化量"
            value="取区间内**有记录**的首条与末条之差，不是日历首末日"
            hint="只有一条记录时整块不显示"
          />
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          回顾只陈述事实：没有完成度、没有达成率、也不给建议 —— 这些数字不参与任何评分。
        </p>
      </section>

      {/* ⑭ 不同食物的种类是怎么数出来的（R11.7 / R11.3 共用口径，T02 同批交付） */}
      <section aria-labelledby="why-distinct-foods-title" className="qsh-surface rounded-2xl p-5">
        <h2 id="why-distinct-foods-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑭ 不同食物的种类是怎么数出来的
        </h2>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow term="数据来源" value="区间内你记下的饮食条目" />
          <DerivationRow term="身份口径" value="归一化后的显示名优先，缺失时按食物库编号" hint="「种类」是用户的语言" />
          <DerivationRow term="同名合并" value="库内条目与同名的快速记录算同一种" />
          <DerivationRow term="同日多次" value="同一天吃多次只算 1 种" />
          <DerivationRow term="展示上限" value="清单最多显示 200 条" hint="超出时提示「已经很多啦，先显示这些」" />
          <DerivationRow term="这个数字的用途" value="只用来回看" hint="不参与任何评分或推荐" />
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          「吃了多少种」没有好坏，也不是目标 —— 周报和阶段回顾用的是同一个数法，两处数字永远一致。
        </p>
      </section>

      {/* ⑮ 「体重之外的变化」这个数字怎么用（R11.4，T05 同批交付） */}
      <section aria-labelledby="why-wins-title" className="qsh-surface rounded-2xl p-5">
        <h2 id="why-wins-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑮「体重之外的变化」这个数字怎么用
        </h2>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow term="数据来源" value="区间内你写下的句子条数" />
          <DerivationRow term="只能记今天" value="不支持补录" hint="把补录做成任务会带来完成压力" />
          <DerivationRow term="删除" value="不进回收站" hint="随账号删除一并清除" />
          <DerivationRow term="导出" value="备份文件里是独立的 wins 段（结构版本 2）" hint="旧备份没有这段也能正常打开" />
          <DerivationRow term="这个数字的用途" value="只在回顾页出现这一句计数" hint="不参与热量、体重或目标的任何计算" />
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          这句话只用来回看 —— 不计分、不评级、不设目标，也不是每天必须完成的任务。
        </p>
      </section>

      {/* ⑯ 周报里的「饱和脂肪」是怎么来的（CFCD 扩量推算值，NFR-11） */}
      <section aria-labelledby="why-sfa-title" className="qsh-surface rounded-2xl p-5">
        <h2 id="why-sfa-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑯ 周报里的「饱和脂肪」是怎么来的
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          周报的「微量营养素（日均）」里有一条「饱和脂肪」。它和热量、蛋白那些不太一样 ——
          有一部分不是数据源直接给的克数，而是按比例**推算**出来的，所以在这里把口径摊开讲清楚。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow
            term="推算公式"
            value="饱和脂肪(g) ÷ 100g = 总脂肪(g) × SFA% ÷ 100"
            hint="SFA% 是「饱和脂肪酸占总脂肪酸的百分比」"
          />
          <DerivationRow
            term="数据来源"
            value="《中国食物成分表》（个人非商业自用）"
            hint="平台给的是 SFA 占比，不是克数"
          />
          <DerivationRow term="什么时候留空" value="脂肪或 SFA% 缺任一项 → 留空" hint="不猜、也不用单/多不饱和反推" />
          <DerivationRow term="合理性校验" value="推算值必须 ≤ 总脂肪" hint="否则判为数据异常，留空不显示" />
          <DerivationRow term="USDA 条目" value="直接用其原始饱和脂肪克数" hint="不属于推算值" />
        </dl>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么是「推算」而不是直接抄一个克数</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              《中国食物成分表》给的是「饱和脂肪酸占总脂肪酸的比例」，不是每 100 克的克数。
              若把这个比例直接当克数用，会高估好几倍（比如 60% 会被误读成 60 克）。
              我们用「总脂肪 × 这个比例」换算，得到的才是有意义的克数。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">缺了为什么不补</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              没有脂肪、或没有占比时，宁可留空，也不拿单不饱和 / 多不饱和去反推 ——
              凑出来的数字看着完整，其实并不可信。缺就缺，我们不编。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          饱和脂肪为参考值，不构成营养诊断；参考条按《中国居民膳食营养素参考摄入量》成人一般人群口径。
        </p>
      </section>

      {/* ⑰ AI 剩余次数是怎么算的（B6，同批交付） */}
      <section aria-labelledby="why-ai-usage-title" className="qsh-surface rounded-2xl p-5">
        <h2 id="why-ai-usage-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑰ AI 页面那个「还能问 N 次」是怎么算的
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          AI 页顶部那一行数字不是一个估算 —— 它是你今天实际问过的次数，直接从服务端的计数表里读出来的。
          算式和来源都在下面。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow
            term="数据来源"
            value="ai_usage 表当日各功能行的 request_count 合计"
            hint="usage_date = 服务端本地今天"
          />
          <DerivationRow term="算法" value={`剩余 = ${AI_DAILY_LIMIT} − 已用`} hint="最小为 0，不会是负数" />
          <DerivationRow
            term="哪些算一次"
            value="每日总结 / 今日方案 / 自由提问 / 食物识别，各计 1 次"
            hint="四个入口共用同一个额度"
          />
          <DerivationRow
            term="哪些不算"
            value="今日方案命中缓存不重复计；医疗安全闸的回答不消耗"
            hint="这两类不调用模型"
          />
          <DerivationRow term="什么时候重置" value="每天本地零点重新计" hint="不累计、不清零之外的惩罚" />
          <DerivationRow term="查用量本身" value="不计数" hint="看多少次都不影响剩余" />
        </dl>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么用完时只说一句「明天再来也行」</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              次数是我们这一侧的成本安排，不是你该被考核的指标。说成「已达上限」「次数用尽」会把它变成一次小小的否定，
              所以我们只把事实摆出来，剩下的留给你决定明天要不要再来。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">拿不到这个数字会怎样</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              那一行直接不出现，页面其他部分照常用 —— 用量只是展示，取不到不拦你、也不报错。
              AI 未配置（没有模型密钥）时它也会照常显示，因为计的是次数，与模型是否可用无关。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          阈值 <span className="font-mono">AI_DAILY_LIMIT</span> 与换算函数{' '}
          <span className="font-mono">deriveAiUsage</span> 都来自 @qsh/core：页面、接口与限额判定用的是同一份，
          不会各说各话。
        </p>
      </section>

      {/* ⑱ 改份量后，热量是怎么重算的（B3，NFR-11） */}
      <section aria-labelledby="why-portion-title" className="qsh-surface rounded-2xl p-5">
        <h2 id="why-portion-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑱ 改份量后，热量是怎么重算的
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          记完发现份量填错了，直接改一下就好 —— 不用删掉重新搜。
          改完这条会按食物库重新算一遍，口径和「新记一条」完全一样。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow
            term="数据来源"
            value="食物库里那一条的「每 100g」值"
            hint="不是你手填的数字，也不是上次记的快照"
          />
          <DerivationRow
            term="重算公式"
            value="每 100g 值 × 克数 ÷ 100"
            hint="与新建记录用的是同一个函数（@qsh/core 的 scaleFoodNutrients）"
          />
          <DerivationRow term="取整" value="保留 1 位小数" hint="与服务端同一把取整（round1）" />
          <DerivationRow
            term="份量怎么折成克数"
            value="填的克数 > 份量单位 × 份数 > 默认份量 > 100g"
            hint="顺序与新建时一致"
          />
          <DerivationRow
            term="快速加卡的条目改什么"
            value="改的是热量本身"
            hint="它没有食物库参照物，改克数不会重算任何数字"
          />
          <DerivationRow term="会不会动到别的记录" value="不会" hint="只改这一条，顺序与其它条目都不变" />
          <DerivationRow
            term="会不会提示「超出预算」"
            value="不会"
            hint="改份量只是把数字改对，不给任何评价"
          />
        </dl>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么「改成 200g」和「重新记一条 200g」一定同一个数</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              两条路径调用的是同一个函数：新建走它，改份量也走它。
              不复制一份公式，就不会出现「同一件事两个数字」—— 这是我们对可解释性的底线。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么改大了也不提醒</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              份量填错是最常见的事，改一下就好。我们不会在这一步弹「超出预算」「吃多了」之类的提醒 ——
              那会把一次普通的修正变成一次被评价的经历。数字改对就够了，判断留给你。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          重算只服务「把数字改对」这一件事：不参与任何预算判断、不产生任何评价，也不改变其它记录。
        </p>
      </section>

      {/* ⑲ JSON 备份恢复预览与合并口径（R10.2 / NFR-11） */}
      <section aria-labelledby="why-restore-title" className="qsh-surface rounded-2xl p-5">
        <h2 id="why-restore-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑲ 备份恢复里的数字怎么来
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          选择 JSON 备份后看到的条数与日期跨度，只来自这份文件；预览阶段不写入任何记录。
          确认页也会把合并规则原样列出，不做静默覆盖。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow term="统计来源" value="已通过结构校验的 JSON 备份" hint="支持结构版本 1 和 2" />
          <DerivationRow term="体重 / 运动 / 习惯 / 饮水 / 这句话" value="各自数组的记录条数" />
          <DerivationRow term="餐次条目" value="meals 每个餐次里的 items 数量之和" hint="不是餐次分组数量" />
          <DerivationRow term="整体日期跨度" value="6 类记录全部日期中的最早日 ～ 最晚日" hint="没有日期记录时不编造区间" />
          <DerivationRow term="同日覆盖" value="备份出现某日时，该实体当天改用备份记录" />
          <DerivationRow term="不同日追加" value="备份没有出现的日期保留现有记录" hint="不会清空整段历史" />
          <DerivationRow term="档案 / 目标 / 设置" value="采用备份中的内容" hint="确认前会明确说明" />
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          预览条数用于让你确认文件内容，合并口径用于说明会发生什么；两者都不参与评分或健康判断。
        </p>
      </section>

      {/* ⑳「我的常点」是怎么记住的（C2，同批交付） */}
      <section aria-labelledby="why-tool-memory-title" className="qsh-surface rounded-2xl p-5">
        <h2 id="why-tool-memory-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ⑳ 生活化工具里的「我的常点」是怎么记住的
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          外卖和饮品工具会记住你常用的品类与档位，下次打开先帮你选好。
          它<strong className="font-semibold">只做这一件事</strong>：替你省一次点选 —— 不推荐、不排序、也不评价你点了什么。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow
            term="存在哪儿"
            value="你自己的浏览器（本机 localStorage）"
            hint="不上传、不进账号、不参与导出"
          />
          <DerivationRow
            term="记什么"
            value="外卖的品类；饮品的品类 + 杯型 + 糖度"
            hint="只记选项本身"
          />
          <DerivationRow
            term="频次口径"
            value="用过的**天数**，不是次数"
            hint="同一天换着点几次也只算 1 天 —— 与常吃榜同源"
          />
          <DerivationRow
            term="回读规则"
            value="天数最多 → 最近用过 → 选项名"
            hint="完全确定，不会因为刷新而变"
          />
          <DerivationRow term="保留窗口" value={`近 ${TOOL_MEMORY_LIMITS.windowDays} 天`} hint="更早的日期会自然淡出" />
          <DerivationRow
            term="上限"
            value={`每个工具最多 ${TOOL_MEMORY_LIMITS.choicesPerTool} 组`}
            hint="超出按最近用过的裁剪"
          />
          <DerivationRow
            term="会不会改估算结果"
            value="不会"
            hint="热量区间仍由 @qsh/core 的估算函数决定"
          />
          <DerivationRow
            term="库里没有的旧档位"
            value="自动忽略，回落到默认"
            hint="绝不拿已不存在的选项去预选"
          />
        </dl>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么只记忆，不给你推荐</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              「推荐」意味着我们替你判断了哪样更好，而判断「更好」就免不了带上评分 ——
              那正是我们不做的事（见 ⑪）。常点只复述你自己做过的选择：你点得多的，下次先帮你选好，
              换掉它随时都可以，也不会有人因此说你一句。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么只存在本机，不跟着账号走</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              它只是个省事的小偏好，够不上「你的数据」，所以没必要送到服务器上。
              代价是换设备 / 清缓存会丢 —— 我们觉得这个代价比「多一份你的饮食偏好在云端」更划算；
              退出登录或清空缓存时它会一并清掉。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          记忆只影响「默认选中哪一项」，不影响任何热量区间、预算与目标数字 —— 也不参与任何评价。
        </p>
      </section>

      {/* ㉑ 待同步条数（GAP-9，NFR-11：新展示的数字必须可解释） */}
      <section aria-labelledby="why-pending-sync-title" className="qsh-surface rounded-2xl p-5">
        <h2 id="why-pending-sync-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
          ㉑ 顶部那个「还有 N 笔在排队」是怎么来的
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          断网时你照样能记，记录会先存在本机，联网后自动送出去。顶部那条横幅主行讲网络，
          副行的数字就是「还留在本机、还没送出去」的笔数。它的口径在下面。
        </p>
        <dl className="mt-3 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
          <DerivationRow
            term="这个数字是什么"
            value="本机待同步队列里的条目数"
            hint="不是「今天记了几笔」，也不是「失败了几次」"
          />
          <DerivationRow
            term="存在哪儿"
            value="浏览器 IndexedDB（离线队列 qsh-offline）"
            hint="不支持 IndexedDB 的环境自动降级为内存队列"
          />
          <DerivationRow
            term="怎么加一"
            value="断网时记一笔（体重 / 饮食 / 运动 / 饮水 / 习惯 / 这句话）即入队 +1"
          />
          <DerivationRow
            term="怎么减一"
            value="联网后每条成功送出就 -1"
            hint="成功 = 服务端真的接收了，不是「试着发了」"
          />
          <DerivationRow
            term="什么时候归零"
            value="队列空了就归零，横幅随之收起"
            hint="不写「账已结清」这类常驻文案"
          />
          <DerivationRow
            term="顺序"
            value="按本地写入时间先来先送"
            hint="同一份数据以本地最新时间为准（服务端覆盖）"
          />
          <DerivationRow
            term="为什么显示「笔」而不是「条数据量」"
            value="一笔 = 一次记录动作"
            hint="与你在页面上做的动作一一对应，不用换算"
          />
        </dl>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">为什么联网了还一直显示</dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              联网那一刻数字不会马上变 0 —— 队列还要一条条真的送出去。这段等待里，横幅继续留着，
              你才能看见「还差几笔」以及它最终归零。等队列空了，横幅自己就收起来了。
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">
              为什么我们**不**告诉你「有几笔没能送出去」
            </dt>
            <dd className="mt-0.5 text-slate-600 dark:text-slate-300">
              某条记录可能连着几次都送不出去（比如它引用的那条记录已经被删了），
              这时我们会把它从队列里放下，不再反复打扰你。但**那个数字我们不说** ——
              把「丢了 N 条」摆到眼前，只会让你回头一条条去对，而这几笔多半本来就是写不进来的内容。
              我们只留一句「回头在页面上补一笔就好」：想补就补，不补也没关系。
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
          这个数字只说明「本机还有几笔在路上」，不评价你、也不影响任何记录内容 ——
          它归零只代表它们都送到了，不代表你今天做得够不够好。
        </p>
      </section>

      {/* 页面间导航 */}
      <nav aria-label="相关页面" className="flex flex-wrap gap-3 text-sm">
        <Link
          to="/dashboard"
          className="qsh-touch-target inline-flex items-center font-medium text-brand-700 dark:text-brand-300"
        >
          ← 回到今天
        </Link>
        <Link
          to="/tools"
          className="qsh-touch-target inline-flex items-center font-medium text-brand-700 dark:text-brand-300"
        >
          去生活化工具看看 →
        </Link>
      </nav>
    </section>
  );
}
