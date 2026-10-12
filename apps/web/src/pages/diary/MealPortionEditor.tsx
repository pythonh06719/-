import { useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { scaleFoodNutrients } from '@qsh/core';
import type { FoodItem, MealLog, UpdateMealLogRequest } from '@qsh/shared-types';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { COPY } from '@/lib/copy';
import { energyLabel, fromDisplayEnergy, toDisplayEnergy, useUnitStore } from '@/lib/units';
import { resolveMealLogName } from '@/lib/meal-name';
import { DEFAULT_SERVING_GRAMS } from './meal-utils';

/**
 * 改份量 / 改热量面板（pages/diary/MealPortionEditor.tsx，B3）。
 *
 * 两类记录改的东西不一样，**这是刻意的**：
 * - **食物库条目**（`foodItemId` 非空）：改**份量**（克数 / 份量单位），热量由服务端按食物库重算；
 *   面板里的「改后 ≈ N」用 `@qsh/core` 的 `scaleFoodNutrients` 现场算 —— 与服务端**同一个函数**，
 *   所以预览和保存后的数字必然一致（NFR-11）。
 * - **快速加卡 / 自定义条目**（`foodItemId` 为空）：库里没有参照物，改的是**热量本身**。
 *
 * 🔴 **无负罪感红线（PRD §7）**：本面板**不出现任何预算 / 超标 / 超出 / 目标相关的字样**，
 * 改大改小都不给评价、不给提示 —— 份量是用户的事，我们只负责把数字改对。
 *
 * ## UI 规范自检（`docs/VISUAL-SYSTEM.md`）
 * - 触控：所有按钮与输入框一律 `qsh-touch-target`（≥44×44）；
 * - 圆角 / 动效：用语义令牌 `rounded-control` / `duration-qsh-base` + `ease-qsh-out`，不写数值；
 * - 对比度：12px（`text-xs`）文字统一 `slate-600` / `dark:slate-300`；
 * - 状态：禁用用 `disabled:opacity-60` 保留控件；输入错误只给一句中性提示，不用红色恐吓。
 */

/** 一次「改份量」提交。 */
export interface PortionEditSubmit {
  /** 发给 `PATCH /api/meals/:id` 的字段（食物库条目**只发份量**，热量由服务端重算） */
  body: UpdateMealLogRequest;
  /** 本地乐观展示用的「改后热量」（食物库条目用 core 同一公式算出） */
  kcalPreview: number;
  /** 解析后的展示名（库内条目取食物库名称，快加条目取手填名） */
  name: string;
  /** 改后的克数（快加条目改热量时为原值或 `null`） */
  grams: number | null;
}

export interface MealPortionEditorProps {
  /** 待改的记录 */
  log: MealLog;
  /** 关闭（不改） */
  onCancel: () => void;
  /** 提交（由父组件负责 PATCH / 离线入队 / 播报） */
  onSubmit: (payload: PortionEditSubmit) => Promise<void>;
}

/** 克数输入是否合法（> 0 的有限数）。 */
function isValidGrams(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

export default function MealPortionEditor({
  log,
  onCancel,
  onSubmit,
}: MealPortionEditorProps): ReactElement {
  const unit = useUnitStore((state) => state.unit);
  /** 是否为食物库条目（是 → 改份量并重算；否 → 改热量本身）。 */
  const isLibrary = log.foodItemId !== null;

  const [grams, setGrams] = useState<string>(() => String(log.grams ?? DEFAULT_SERVING_GRAMS));
  const [servingUnit, setServingUnit] = useState<string | null>(null);
  const [servingQty, setServingQty] = useState<string>('1');
  const [kcalInput, setKcalInput] = useState<string>(() => String(toDisplayEnergy(log.kcal, unit)));
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  /**
   * 食物库条目：拉一次 `GET /foods/:id` 拿**份量单位表**与每 100g 值。
   *
   * 取不到时**不阻塞**（降级为纯克数输入，预览按本条现有热量等比估算）——
   * 改份量是刚需，不能因为一个只读请求失败就改不了。
   */
  const foodQuery = useQuery({
    queryKey: queryKeys.foodById(log.foodItemId ?? 0),
    queryFn: () => api.get<FoodItem>(`/foods/${log.foodItemId as number}`),
    enabled: isLibrary,
    retry: 0,
  });

  /**
   * 展示名（与日记列表**同一口径**）：`customName ?? foodName ?? 食物库名 ?? 这条记录`。
   *
   * `foodName` 由服务端在返回记录时派生（食物库名快照），因此**即使下面的
   * `GET /foods/:id` 还没回来 / 失败，名字也已可读**；`food?.name` 只是兜底
   * （兼容未带 `foodName` 的旧响应）。那个请求**不能省** —— 它还要拿
   * `servingUnits`（份量单位表）与每 100g 值做热量预览（见 `previewKcal`）。
   */
  const food = foodQuery.data ?? null;
  const displayName = resolveMealLogName(log, food?.name ?? '这条记录');

  const gramsNumber = Number(grams);
  /** 改后热量预览：食物库条目按 core 公式算；快加条目直接用填的值。 */
  const previewKcal = ((): number => {
    if (!isLibrary) {
      const trimmed = kcalInput.trim();
      const parsed = Number(trimmed);
      return trimmed !== '' && Number.isFinite(parsed) && parsed >= 0
        ? fromDisplayEnergy(parsed, unit)
        : log.kcal;
    }
    if (food !== null && Number.isFinite(gramsNumber) && gramsNumber > 0) {
      return scaleFoodNutrients(food, gramsNumber).kcal;
    }
    // 食物详情还没到（或取不到）：按本条现有热量等比估算，只用于预览，不写库。
    if (Number.isFinite(gramsNumber) && gramsNumber > 0 && log.grams !== null && log.grams > 0) {
      return (log.kcal * gramsNumber) / log.grams;
    }
    return log.kcal;
  })();

  /** 选一个份量单位：克数同步为该单位 × 份数。 */
  const chooseUnit = (item: { unit: string; grams: number }): void => {
    const qty = Number(servingQty);
    const count = Number.isFinite(qty) && qty > 0 ? qty : 1;
    setServingUnit(item.unit);
    setGrams(String(Math.round(item.grams * count * 10) / 10));
  };

  /** 改份数：克数 = 单位克数 × 份数。 */
  const changeQty = (value: string): void => {
    setServingQty(value);
    const item = (food?.servingUnits ?? []).find((row) => row.unit === servingUnit);
    if (item === undefined) {
      return;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      setGrams(String(Math.round(item.grams * parsed * 10) / 10));
    }
  };

  const run = async (): Promise<void> => {
    setHint(null);

    if (!isLibrary) {
      const trimmed = kcalInput.trim();
      const parsed = Number(trimmed);
      // 空串会被 `Number()` 当成 0 —— 必须显式排除，否则「还没填」会被当成「填 0」。
      if (trimmed === '' || !Number.isFinite(parsed) || parsed < 0) {
        setHint('热量填一个不小于 0 的数字就好');
        return;
      }
      setBusy(true);
      try {
        await onSubmit({
          body: { kcal: fromDisplayEnergy(parsed, unit) },
          kcalPreview: fromDisplayEnergy(parsed, unit),
          name: displayName,
          grams: log.grams,
        });
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!isValidGrams(grams)) {
      setHint('份量填一个大于 0 的数字就好');
      return;
    }
    setBusy(true);
    try {
      const qty = Number(servingQty);
      const body: UpdateMealLogRequest =
        servingUnit !== null && Number.isFinite(qty) && qty > 0
          ? { servingUnit, servingQty: qty }
          : { grams: gramsNumber };
      await onSubmit({
        body,
        kcalPreview: previewKcal,
        name: displayName,
        grams: gramsNumber,
      });
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isLibrary ? COPY.portionEditTitle : COPY.portionEditKcalTitle}
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 dark:bg-slate-950/65 sm:items-center sm:p-4"
    >
      <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-sheet bg-white p-5 shadow-qsh-3 dark:bg-slate-800 sm:rounded-sheet">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            {isLibrary ? COPY.portionEditTitle : COPY.portionEditKcalTitle}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="qsh-touch-target rounded-control px-3 text-sm text-slate-500 dark:text-slate-400"
            aria-label="关闭改份量面板"
          >
            关闭
          </button>
        </div>
        <p className="mt-tight text-sm text-slate-700 dark:text-slate-200">{displayName}</p>
        <p className="mt-tight text-xs text-slate-600 dark:text-slate-300">
          {isLibrary ? COPY.portionEditHint : COPY.portionEditKcalHint}
        </p>

        {isLibrary ? (
          <div className="mt-4 space-y-3">
            {food !== null && (food.servingUnits ?? []).length > 0 && (
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-300">按份量单位</p>
                <div className="mt-tight flex flex-wrap gap-2">
                  {food.servingUnits.map((item) => (
                    <button
                      key={`${item.unit}-${item.grams}`}
                      type="button"
                      aria-pressed={servingUnit === item.unit}
                      onClick={() => chooseUnit(item)}
                      className={[
                        'qsh-touch-target rounded-pill px-3 text-sm transition duration-qsh-base ease-qsh-out',
                        servingUnit === item.unit
                          ? 'bg-brand-600 text-white'
                          : 'bg-brand-50 text-slate-600 dark:bg-slate-900 dark:text-slate-300',
                      ].join(' ')}
                    >
                      {item.label ?? `1 ${item.unit}`}（{item.grams}g）
                    </button>
                  ))}
                </div>
                {servingUnit !== null && (
                  <label className="mt-2 block text-sm text-slate-600 dark:text-slate-300">
                    份数
                    <input
                      inputMode="decimal"
                      value={servingQty}
                      onChange={(event) => changeQty(event.target.value)}
                      className="mt-tight w-full rounded-control border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                    />
                  </label>
                )}
              </div>
            )}

            <label className="block text-sm text-slate-600 dark:text-slate-300">
              克数
              <input
                inputMode="decimal"
                value={grams}
                onChange={(event) => {
                  setGrams(event.target.value);
                  setServingUnit(null);
                }}
                aria-label={`${displayName} 的克数`}
                className="mt-tight w-full rounded-control border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>

            <p className="qsh-tnum text-sm text-brand-700 dark:text-brand-200" aria-live="polite">
              改后约 {toDisplayEnergy(previewKcal, unit)} {energyLabel(unit)}
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block text-sm text-slate-600 dark:text-slate-300">
              热量（{energyLabel(unit)}）
              <input
                inputMode="numeric"
                value={kcalInput}
                onChange={(event) => setKcalInput(event.target.value)}
                aria-label={`${displayName} 的热量`}
                className="mt-tight w-full rounded-control border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
          </div>
        )}

        {hint !== null && (
          <p role="status" className="mt-block rounded-control bg-brand-50 px-3 py-2 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
            {hint}
          </p>
        )}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy}
            className="qsh-touch-target flex-1 rounded-control bg-brand-600 py-3 font-medium text-white transition duration-qsh-base ease-qsh-out hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? '正在改…' : COPY.portionEditSave}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="qsh-touch-target rounded-control bg-brand-50 px-4 text-sm text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
          >
            {COPY.portionEditCancel}
          </button>
        </div>
      </div>
    </div>
  );

  /**
   * 挂到 `body`：`AppShell` 的 `<main>` 带 `animate-fade-in`（keyframes 含 `transform`），
   * 祖先有 transform 时会成为 `position: fixed` 后代的**包含块** —— 这层 `fixed inset-0`
   * 于是相对 `<main>`（高 1156px）而非视口（844px）定位，390×844 实测面板被推到
   * `t=863`，**整块落在折线以下**，且顶部 93px 原页面不被遮罩覆盖（可点击穿透）。
   * 详见 `MealComposer.tsx` 中同名 `dialog` 变量的完整注释。
   */
  return createPortal(dialog, document.body);
}
