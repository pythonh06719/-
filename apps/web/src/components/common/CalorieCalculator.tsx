import { useMemo, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { safeCalcCalorieBudget, WARNING_CODES } from '@qsh/core';
import type { ActivityLevel, CalorieInput, Gender, SafeCalorieResult } from '@qsh/core';

const ACTIVITY_OPTIONS: ReadonlyArray<{ value: ActivityLevel; label: string }> = [
  { value: 'sedentary', label: '久坐（几乎不运动）' },
  { value: 'light', label: '轻度活动（每周 1–3 次）' },
  { value: 'moderate', label: '中度活动（每周 3–5 次）' },
  { value: 'high', label: '高强度（每周 6–7 次）' },
  { value: 'athlete', label: '运动员（每天高强度）' },
];

/** 输入框原始值（字符串态，便于受控输入）。 */
interface FormState {
  gender: Gender;
  age: string;
  heightCm: string;
  weightKg: string;
  targetWeightKg: string;
  targetWeeks: string;
  activityLevel: ActivityLevel;
}

const INITIAL_FORM: FormState = {
  gender: 'female',
  age: '30',
  heightCm: '165',
  weightKg: '60',
  targetWeightKg: '55',
  targetWeeks: '12',
  activityLevel: 'sedentary',
};

/** 表单控件共用样式（含深色变体；`dark:bg-slate-900` 沿用「我的」页输入框惯例）。 */
const FIELD_CLASS =
  'mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100';

/** 将字符串安全转为数字（空串 / 非法 → NaN，交由引擎校验）。 */
function toNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

/**
 * 免注册试用热量计算器（US-01）。
 *
 * **全程零网络请求、零落库、无注册**：本地 state 收集输入 → 调用 `@qsh/core`
 * 的 `safeCalcCalorieBudget` → 就地展示 BMR / TDEE / 建议摄入 + 安全提示。
 * 文案遵循 PRD §7：鼓励式、无负罪感。
 *
 * 浅色 / 深色两态均完整适配（卡片、表单、错误块、结果块、提示条），对比度按既有口径 ≥ 4.5。
 */
export default function CalorieCalculator(): ReactElement {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [outcome, setOutcome] = useState<SafeCalorieResult | null>(null);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const input: CalorieInput = {
      gender: form.gender,
      age: toNumber(form.age),
      heightCm: toNumber(form.heightCm),
      weightKg: toNumber(form.weightKg),
      targetWeightKg: toNumber(form.targetWeightKg),
      targetWeeks: toNumber(form.targetWeeks),
      activityLevel: form.activityLevel,
    };
    // 纯本地计算，不发起任何网络请求
    setOutcome(safeCalcCalorieBudget(input));
  };

  const result = useMemo(() => (outcome && outcome.ok ? outcome.result : null), [outcome]);

  /**
   * 结果侧提示：`safetyMessages`（直接渲染文案）与 `warnings`（结构化告警）按 `code` **去重取一**
   * （ARCHITECTURE §4.5 末尾约定）。触下限时 `safetyMessages` 已承载 `W_FLOOR_APPLIED` 的文案语义，
   * 故从 warnings 渲染中剔除该码，避免重复展示；其余告警（如激进减重提示）照常展示。
   */
  const notices = useMemo<string[]>(() => {
    if (result === null) {
      return [];
    }
    const covered = new Set<string>();
    if (result.floorApplied) {
      covered.add(WARNING_CODES.FLOOR_APPLIED);
    }
    const warningMessages = result.warnings
      .filter((warning) => !covered.has(warning.code))
      .map((warning) => warning.message);
    return [...result.safetyMessages, ...warningMessages];
  }, [result]);

  return (
    <section
      aria-label="免注册热量计算器"
      className="mx-auto w-full max-w-xl qsh-surface p-6"
    >
      <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
        先算一算，再决定要不要用
      </h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        无需注册，数据只在你的浏览器里计算，不会上传。
      </p>

      <form className="mt-5 grid grid-cols-2 gap-4" onSubmit={handleSubmit}>
        <label className="col-span-1 text-sm text-slate-600 dark:text-slate-300">
          性别
          <select
            className={FIELD_CLASS}
            value={form.gender}
            onChange={(e) => update('gender', e.target.value as Gender)}
          >
            <option value="female">女</option>
            <option value="male">男</option>
          </select>
        </label>

        <label className="col-span-1 text-sm text-slate-600 dark:text-slate-300">
          年龄（周岁）
          <input
            className={FIELD_CLASS}
            inputMode="numeric"
            value={form.age}
            onChange={(e) => update('age', e.target.value)}
          />
        </label>

        <label className="col-span-1 text-sm text-slate-600 dark:text-slate-300">
          身高（cm）
          <input
            className={FIELD_CLASS}
            inputMode="decimal"
            value={form.heightCm}
            onChange={(e) => update('heightCm', e.target.value)}
          />
        </label>

        <label className="col-span-1 text-sm text-slate-600 dark:text-slate-300">
          当前体重（kg）
          <input
            className={FIELD_CLASS}
            inputMode="decimal"
            value={form.weightKg}
            onChange={(e) => update('weightKg', e.target.value)}
          />
        </label>

        <label className="col-span-1 text-sm text-slate-600 dark:text-slate-300">
          目标体重（kg）
          <input
            className={FIELD_CLASS}
            inputMode="decimal"
            value={form.targetWeightKg}
            onChange={(e) => update('targetWeightKg', e.target.value)}
          />
        </label>

        <label className="col-span-1 text-sm text-slate-600 dark:text-slate-300">
          目标期限（周）
          <input
            className={FIELD_CLASS}
            inputMode="numeric"
            value={form.targetWeeks}
            onChange={(e) => update('targetWeeks', e.target.value)}
          />
        </label>

        <label className="col-span-2 text-sm text-slate-600 dark:text-slate-300">
          活动量
          <select
            className={FIELD_CLASS}
            value={form.activityLevel}
            onChange={(e) => update('activityLevel', e.target.value as ActivityLevel)}
          >
            {ACTIVITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          className="col-span-2 mt-1 rounded-lg bg-brand-600 px-4 py-3 font-medium text-white transition hover:bg-brand-700"
        >
          计算我的每日预算
        </button>
      </form>

      {outcome !== null && !outcome.ok && (
        <div className="mt-5 rounded-xl bg-amber-50 p-4 dark:bg-amber-900/30" role="status">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            马上就能算了，帮我们看看：
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-100">
            {outcome.errors.map((error) => (
              <li key={`${error.field}-${error.code}`}>{error.message}</li>
            ))}
          </ul>
        </div>
      )}

      {result !== null && (
        <div className="mt-6" aria-live="polite">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl bg-brand-50 p-3 dark:bg-brand-900/40">
              <p className="text-xs text-slate-600 dark:text-slate-400">基础代谢 BMR</p>
              <p className="mt-1 text-xl font-semibold text-slate-800 dark:text-slate-100">{result.bmr}</p>
              <p className="text-xs text-slate-600 dark:text-slate-400">kcal</p>
            </div>
            <div className="rounded-xl bg-brand-50 p-3 dark:bg-brand-900/40">
              <p className="text-xs text-slate-600 dark:text-slate-400">每日消耗 TDEE</p>
              <p className="mt-1 text-xl font-semibold text-slate-800 dark:text-slate-100">{result.tdee}</p>
              <p className="text-xs text-slate-600 dark:text-slate-400">kcal</p>
            </div>
            <div className="rounded-xl bg-brand-100 p-3 dark:bg-brand-900/40">
              <p className="text-xs text-brand-700 dark:text-brand-200">建议摄入</p>
              <p className="mt-1 text-xl font-semibold text-brand-700 dark:text-brand-200">
                {result.intakeRecommended}
              </p>
              <p className="text-xs text-brand-600 dark:text-brand-300">kcal</p>
            </div>
          </div>

          {notices.length > 0 && (
            <ul className="mt-4 space-y-2">
              {notices.map((message) => (
                <li
                  key={message}
                  className="rounded-xl border border-brand-100 bg-white px-4 py-2 text-sm text-brand-700 dark:border-slate-700 dark:bg-slate-800 dark:text-brand-200"
                >
                  {message}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            参考来源：Mifflin-St Jeor（1990）基础代谢公式、2024 成人活动 MET 汇编。
            结果仅为健康生活参考，不构成医疗建议。孕期 / 哺乳期 / 疾病治疗期请咨询专业医师。
          </p>
        </div>
      )}
    </section>
  );
}
