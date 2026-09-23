import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ACTIVITY_FACTORS,
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
  ageFromBirthDate,
  buildSafetyMessages,
  deriveWeeklyLossKg,
  safeCalcCalorieBudget,
} from '@qsh/core';
import type { ActivityLevel, CalorieResult, Gender } from '@qsh/core';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth.store';
import { queryKeys } from '@/lib/queryClient';

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
          食物库共 443 条，逐条标注来源与许可；代码为 MIT，数据是混合来源（详见仓库 DATA-LICENSE.md）。
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
          </tbody>
        </table>
        <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">
          署名：© Open Food Facts contributors（ODbL 1.0）；USDA FoodData Central — SR Legacy（公有领域）。
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
