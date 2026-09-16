import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import type { ActivityLevel, Gender, OnboardingRequest, OnboardingResponse } from '@qsh/shared-types';
import { ACTIVITY_FACTORS, ageFromBirthDate, safeCalcCalorieBudget } from '@qsh/core';
import type { CalorieInput, CalorieResult } from '@qsh/core';
import { api, ApiClientError } from '@/lib/api';
import { CACHE_KEYS, cacheSet } from '@/lib/local-cache';
import { todayKey } from '@/lib/format';
import { COPY } from '@/lib/copy';
import SafetyBanner from '@/components/feedback/SafetyBanner';
import ProgressRing from '@/components/common/ProgressRing';

/**
 * 首次引导（`/onboarding`）—— 免责声明 → 问卷 → 结果（PRD §6 第 2 行 / US-03 / US-04 / US-20）。
 *
 * ★ 关键设计：
 * - **首屏强制确认免责声明**（R1.5 / TC-38），未确认不进入问卷；
 * - 问卷期间用 `safeCalcCalorieBudget` **本地实时预览**（不发请求、不落库）；
 * - 勾选孕期 / 哺乳期 / 疾病治疗期时给出醒目提示，并**不提供继续按钮**（US-20）；
 * - 提交后由服务端重算并落库；后端未就绪时回退为「本地保存 + 继续体验」（优雅降级）。
 */

type Step = 'disclaimer' | 'form' | 'result';

const ACTIVITY_OPTIONS: ReadonlyArray<{ value: ActivityLevel; label: string; hint: string }> = [
  { value: 'sedentary', label: '久坐', hint: `几乎不运动（系数 ${ACTIVITY_FACTORS.sedentary}）` },
  { value: 'light', label: '轻度活动', hint: `每周 1–3 次（系数 ${ACTIVITY_FACTORS.light}）` },
  { value: 'moderate', label: '中度活动', hint: `每周 3–5 次（系数 ${ACTIVITY_FACTORS.moderate}）` },
  { value: 'high', label: '高强度', hint: `每周 6–7 次（系数 ${ACTIVITY_FACTORS.high}）` },
  { value: 'athlete', label: '运动员', hint: `每天高强度（系数 ${ACTIVITY_FACTORS.athlete}）` },
];

const DIETARY_OPTIONS = ['少油', '少糖', '素食', '清真', '不吃辣', '不吃海鲜'] as const;

/** 高风险人群选项：勾选后不提供继续减重方案的入口（US-20 / TC-38）。 */
const RISK_OPTIONS = ['孕期', '哺乳期', '疾病治疗期'] as const;

/** 其他常见情况（非高风险，但属于敏感健康信息，D3）。 */
const CONDITION_OPTIONS = ['无', '高血压', '糖尿病', '高血脂', '甲状腺相关'] as const;

interface FormState {
  gender: Gender;
  birthDate: string;
  heightCm: string;
  currentWeightKg: string;
  targetWeightKg: string;
  targetWeeks: string;
  activityLevel: ActivityLevel;
  dietaryPreference: string[];
  conditions: string[];
}

const INITIAL_FORM: FormState = {
  gender: 'female',
  birthDate: '1995-01-01',
  heightCm: '165',
  currentWeightKg: '60',
  targetWeightKg: '55',
  targetWeeks: '12',
  activityLevel: 'sedentary',
  dietaryPreference: [],
  conditions: [],
};

function toNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

/** 由表单构造引擎输入（本地预览与提交共用同一份数据）。 */
function buildInput(form: FormState): CalorieInput {
  const age = ageFromBirthDate(form.birthDate, new Date());
  return {
    gender: form.gender,
    age,
    heightCm: toNumber(form.heightCm),
    weightKg: toNumber(form.currentWeightKg),
    targetWeightKg: toNumber(form.targetWeightKg),
    targetWeeks: toNumber(form.targetWeeks),
    activityLevel: form.activityLevel,
  };
}

export default function OnboardingPage(): ReactElement {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('disclaimer');
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [notice, setNotice] = useState<string | null>(null);

  const hasRisk = RISK_OPTIONS.some((item) => form.conditions.includes(item));

  const outcome = useMemo(() => safeCalcCalorieBudget(buildInput(form)), [form]);
  const preview: CalorieResult | null = outcome.ok ? outcome.result : null;
  const previewErrors = outcome.ok ? [] : outcome.errors;

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleInList = (key: 'dietaryPreference' | 'conditions', value: string): void => {
    setForm((prev) => {
      const list = prev[key];
      const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
      return { ...prev, [key]: next };
    });
  };

  const submit = useMutation({
    mutationFn: (payload: OnboardingRequest) => api.post<OnboardingResponse>('/onboarding', payload),
    onSuccess: (data) => {
      cacheSet(CACHE_KEYS.localBudget, data.budget);
      setNotice('预算已经算好啦，我们去今日看板看看');
      navigate('/dashboard');
    },
    onError: (error: unknown) => {
      // 优雅降级：后端未就绪 / 未登录时，把本地预览预算缓存下来，仍可继续体验
      if (preview !== null) {
        cacheSet(CACHE_KEYS.localBudget, preview);
      }
      const reason = error instanceof ApiClientError ? error.message : '稍后我们会再试一次';
      setNotice(`${reason}（已先保存在本机，联网后会自动同步）`);
      navigate('/dashboard');
    },
  });

  const handleSubmit = (): void => {
    if (preview === null) {
      setNotice('还有几项需要补充一下，帮我们看看左侧的提示');
      return;
    }
    const payload: OnboardingRequest = {
      gender: form.gender,
      birthDate: form.birthDate,
      heightCm: toNumber(form.heightCm),
      currentWeightKg: toNumber(form.currentWeightKg),
      targetWeightKg: toNumber(form.targetWeightKg),
      targetWeeks: toNumber(form.targetWeeks),
      activityLevel: form.activityLevel,
      dietaryPreference: form.dietaryPreference,
      conditions: form.conditions,
      disclaimerAccepted: true,
    };
    submit.mutate(payload);
  };

  // ---------------------------------------------------------------------
  // 步骤 1：免责声明确认
  // ---------------------------------------------------------------------
  if (step === 'disclaimer') {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-12">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">开始前，先聊两句</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          我们希望你先了解适用边界，再决定要不要用。这几句话很重要，请读一读。
        </p>

        <section
          aria-label="免责声明"
          className="qsh-surface mt-6 rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
        >
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">免责声明</h2>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
            <li>· 本产品不提供医疗建议，也不能替代专业诊断与治疗。</li>
            <li>· 计算结果仅用于健康生活参考。</li>
            <li>· 孕期、哺乳期或正处于疾病治疗期的朋友，我们不建议使用热量缺口方案。</li>
          </ul>
        </section>

        <button
          type="button"
          onClick={() => setStep('form')}
          className="qsh-touch-target mt-6 w-full rounded-xl bg-brand-600 py-3.5 font-medium text-white transition hover:bg-brand-700"
        >
          我已了解，开始填写
        </button>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="qsh-touch-target mt-3 w-full rounded-xl py-3 text-sm text-slate-600 dark:text-slate-400"
        >
          再想想，先回首页
        </button>
      </main>
    );
  }

  // ---------------------------------------------------------------------
  // 步骤 3：结果页
  // ---------------------------------------------------------------------
  if (step === 'result' && preview !== null) {
    const progress = preview.intakeRecommended > 0 ? 1 : 0;
    return (
      <main className="mx-auto max-w-xl px-5 py-10">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">你的每日热量预算</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          这是根据你填写的信息算出来的，随时可以在「我的」里修改。
        </p>

        <div className="mt-6 flex flex-col items-center">
          <ProgressRing
            value={progress}
            centerValue={String(preview.intakeRecommended)}
            centerLabel="建议摄入 kcal"
            ariaLabel={`建议每日摄入 ${preview.intakeRecommended} 千卡`}
          />
        </div>

        <dl className="mt-6 grid grid-cols-3 gap-3 text-center">
          <div className="qsh-surface rounded-2xl p-3 dark:bg-slate-800 dark:ring-slate-700">
            <dt className="text-xs text-slate-500 dark:text-slate-400">基础代谢</dt>
            <dd className="qsh-tnum mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">
              {preview.bmr}
            </dd>
          </div>
          <div className="qsh-surface rounded-2xl p-3 dark:bg-slate-800 dark:ring-slate-700">
            <dt className="text-xs text-slate-500 dark:text-slate-400">每日消耗</dt>
            <dd className="qsh-tnum mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">
              {preview.tdee}
            </dd>
          </div>
          <div className="qsh-surface rounded-2xl p-3 dark:bg-slate-800 dark:ring-slate-700">
            <dt className="text-xs text-slate-500 dark:text-slate-400">每日缺口</dt>
            <dd className="qsh-tnum mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">
              {Math.round(preview.effectiveDeficit)}
            </dd>
          </div>
        </dl>

        <section aria-label="宏量营养素建议" className="mt-4 qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">三大营养素参考</h2>
          <ul className="mt-3 grid grid-cols-3 gap-3 text-center">
            <li className="rounded-xl bg-brand-50 p-3 dark:bg-brand-900/40">
              <p className="text-xs text-slate-600 dark:text-slate-400">蛋白质</p>
              <p className="qsh-tnum mt-1 font-semibold text-brand-700 dark:text-brand-200">
                {preview.macros.proteinG} g
              </p>
            </li>
            <li className="rounded-xl bg-brand-50 p-3 dark:bg-brand-900/40">
              <p className="text-xs text-slate-600 dark:text-slate-400">脂肪</p>
              <p className="qsh-tnum mt-1 font-semibold text-brand-700 dark:text-brand-200">
                {preview.macros.fatG} g
              </p>
            </li>
            <li className="rounded-xl bg-brand-50 p-3 dark:bg-brand-900/40">
              <p className="text-xs text-slate-600 dark:text-slate-400">碳水</p>
              <p className="qsh-tnum mt-1 font-semibold text-brand-700 dark:text-brand-200">
                {preview.macros.carbG} g
              </p>
            </li>
          </ul>
        </section>

        <div className="mt-4">
          <SafetyBanner
            safetyMessages={preview.safetyMessages}
            warnings={preview.warnings}
            floorApplied={preview.floorApplied}
            isDeficitCapped={preview.isDeficitCapped}
          />
        </div>

        {notice !== null && (
          <p role="status" aria-live="polite" className="mt-4 text-sm text-brand-700 dark:text-brand-300">
            {notice}
          </p>
        )}

        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submit.isPending}
            className="qsh-touch-target w-full rounded-xl bg-brand-600 py-3.5 font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {submit.isPending ? '正在保存…' : '保存并进入今日看板'}
          </button>
          <button
            type="button"
            onClick={() => setStep('form')}
            className="qsh-touch-target w-full rounded-xl py-3 text-sm text-slate-600 dark:text-slate-400"
          >
            返回修改
          </button>
        </div>
      </main>
    );
  }

  // ---------------------------------------------------------------------
  // 步骤 2：问卷
  // ---------------------------------------------------------------------
  return (
    <main className="mx-auto max-w-xl px-5 py-10">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">了解一下你</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
        这些问题只用来计算热量预算，疾病相关信息仅你自己可见。
      </p>

      <form
        className="mt-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          setStep('result');
        }}
      >
        <fieldset className="qsh-surface rounded-2xl p-4 dark:bg-slate-800 dark:ring-slate-700">
          <legend className="px-1 text-sm font-semibold text-slate-700 dark:text-slate-200">基础信息</legend>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <label className="text-sm text-slate-600 dark:text-slate-300">
              性别
              <select
                value={form.gender}
                onChange={(event) => update('gender', event.target.value as Gender)}
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
                value={form.birthDate}
                onChange={(event) => update('birthDate', event.target.value)}
                className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="text-sm text-slate-600 dark:text-slate-300">
              身高（cm）
              <input
                inputMode="decimal"
                value={form.heightCm}
                onChange={(event) => update('heightCm', event.target.value)}
                className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="text-sm text-slate-600 dark:text-slate-300">
              当前体重（kg）
              <input
                inputMode="decimal"
                value={form.currentWeightKg}
                onChange={(event) => update('currentWeightKg', event.target.value)}
                className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="qsh-surface rounded-2xl p-4 dark:bg-slate-800 dark:ring-slate-700">
          <legend className="px-1 text-sm font-semibold text-slate-700 dark:text-slate-200">目标</legend>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <label className="text-sm text-slate-600 dark:text-slate-300">
              目标体重（kg）
              <input
                inputMode="decimal"
                value={form.targetWeightKg}
                onChange={(event) => update('targetWeightKg', event.target.value)}
                className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="text-sm text-slate-600 dark:text-slate-300">
              目标期限（周）
              <input
                inputMode="numeric"
                value={form.targetWeeks}
                onChange={(event) => update('targetWeeks', event.target.value)}
                className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="qsh-surface rounded-2xl p-4 dark:bg-slate-800 dark:ring-slate-700">
          <legend className="px-1 text-sm font-semibold text-slate-700 dark:text-slate-200">活动量</legend>
          <div className="mt-2 space-y-2">
            {ACTIVITY_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 hover:bg-brand-50 dark:hover:bg-slate-700"
              >
                <input
                  type="radio"
                  name="activityLevel"
                  checked={form.activityLevel === option.value}
                  onChange={() => update('activityLevel', option.value)}
                  className="h-4 w-4"
                />
                <span className="text-sm text-slate-700 dark:text-slate-200">
                  {option.label}
                  <span className="ml-2 text-xs text-slate-600 dark:text-slate-400">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="qsh-surface rounded-2xl p-4 dark:bg-slate-800 dark:ring-slate-700">
          <legend className="px-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
            饮食偏好（可多选，也可不选）
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {DIETARY_OPTIONS.map((item) => {
              const active = form.dietaryPreference.includes(item);
              return (
                <button
                  key={item}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleInList('dietaryPreference', item)}
                  className={[
                    'qsh-touch-target rounded-full px-4 text-sm transition',
                    active
                      ? 'bg-brand-600 text-white'
                      : 'bg-brand-50 text-slate-600 dark:bg-slate-900 dark:text-slate-300',
                  ].join(' ')}
                >
                  {item}
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="qsh-surface rounded-2xl p-4 dark:bg-slate-800 dark:ring-slate-700">
          <legend className="px-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
            常见情况（可多选）
          </legend>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            这部分属于敏感信息，仅你自己可见，也可以随时不填。
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {[...RISK_OPTIONS, ...CONDITION_OPTIONS].map((item) => {
              const active = form.conditions.includes(item);
              return (
                <button
                  key={item}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleInList('conditions', item)}
                  className={[
                    'qsh-touch-target rounded-full px-4 text-sm transition',
                    active
                      ? 'bg-coral-500 text-white'
                      : 'bg-brand-50 text-slate-600 dark:bg-slate-900 dark:text-slate-300',
                  ].join(' ')}
                >
                  {item}
                </button>
              );
            })}
          </div>
        </fieldset>

        {hasRisk && (
          <div
            role="status"
            className="rounded-2xl border border-coral-200 bg-coral-50 p-4 dark:border-coral-700 dark:bg-coral-900/30"
          >
            <p className="text-sm font-medium text-coral-700 dark:text-coral-200">先照顾好自己更重要</p>
            <p className="mt-2 text-sm leading-relaxed text-coral-700 dark:text-coral-100">
              {COPY.riskyGroupNotice}
            </p>
          </div>
        )}

        {preview !== null && (
          <div className="rounded-2xl bg-brand-50 p-4 dark:bg-brand-900/30" aria-live="polite">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              实时预览：建议摄入约
              <strong className="mx-1 qsh-tnum text-brand-700 dark:text-brand-200">
                {preview.intakeRecommended}
              </strong>
              kcal / 天（本地计算，未上传）
            </p>
          </div>
        )}

        {previewErrors.length > 0 && (
          <div role="status" className="rounded-2xl bg-brand-50 p-4 dark:bg-brand-900/30">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              还差一点点就能算了，帮我们看看：
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
              {previewErrors.map((error) => (
                <li key={`${error.field}-${error.code}`}>{error.message}</li>
              ))}
            </ul>
          </div>
        )}

        <button
          type="submit"
          disabled={hasRisk || preview === null}
          className="qsh-touch-target w-full rounded-xl bg-brand-600 py-3.5 font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          看看我的预算
        </button>
        {hasRisk && (
          <p className="text-center text-xs text-slate-600 dark:text-slate-400">
            勾选高风险情况后，我们不会提供减重方案按钮，请先咨询专业医师。
          </p>
        )}
      </form>
    </main>
  );
}
