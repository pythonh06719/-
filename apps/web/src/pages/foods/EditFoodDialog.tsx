import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { FOOD_CATEGORIES, foodCategoryLabel } from '@qsh/core';
import type { FoodItem } from '@qsh/shared-types';
import { COPY } from '@/lib/copy';
import { fromDisplayEnergy, toDisplayEnergy, useUnitStore } from '@/lib/units';

/**
 * 「改一下这个食物」编辑弹窗（pages/foods/EditFoodDialog.tsx，C-4 第二步）。
 *
 * 用于「我的食物库」页面：编辑一条**本人自建**食物的名称 / 分类 / 每 100g 热量。
 *
 * ## 交互（照抄 `SaveComboDialog.tsx` 的模态骨架）
 * - `role="dialog"` + `aria-modal` + `aria-labelledby` 关联标题；
 * - Esc 关闭（提交中不响应，避免打断在途请求）；打开时自动聚焦名称输入框；
 * - 提交中禁用按钮，防重复提交；名称未填时给中性提示且**不发请求**；
 * - 服务端错误由父组件通过 `errorText` 就地展示，弹窗**不关闭**、保留已填内容。
 *
 * ## 红线（PRD §7 无负罪感）
 * - **不展示任何新数字**（只回显/编辑已有的每 100g 热量）；
 * - 错误提示只给一句中性话，**不用红色恐吓**；
 * - `source` / `createdByUserId` / `isVerified` 由服务端强制，前端**绝不**提交（也不出现在本弹窗）。
 *
 * ## UI 规范自检（`docs/VISUAL-SYSTEM.md`，对齐 `SaveComboDialog` / `MealPortionEditor`）
 * - 触控：按钮与输入框一律 `qsh-touch-target`（≥44×44）；
 * - 圆角 / 动效：语义令牌 `rounded-control` / `duration-qsh-base` + `ease-qsh-out`；
 * - 对比度：12px（`text-xs`）文字统一 `slate-600` / `dark:slate-300`；
 * - 禁用用 `disabled:opacity-60` 保留控件。
 */

/** 编辑提交体（仅三个可编辑字段；不含 source / createdByUserId）。 */
export interface EditFoodSubmit {
  name: string;
  category: string;
  kcalPer100g: number;
}

export interface EditFoodDialogProps {
  /** 待编辑的食物（父组件从列表项传入，作为表单初值） */
  food: FoodItem;
  /** 是否正在提交（为真时禁用按钮，防重复提交） */
  busy: boolean;
  /** 就地错误提示；`null` = 不展示 */
  errorText: string | null;
  /** 关闭弹窗（不保存） */
  onCancel: () => void;
  /** 提交编辑（父组件负责 PATCH / 缓存刷新 / 播报） */
  onSubmit: (payload: EditFoodSubmit) => void;
}

export default function EditFoodDialog({
  food,
  busy,
  errorText,
  onCancel,
  onSubmit,
}: EditFoodDialogProps): ReactElement {
  const unit = useUnitStore((state) => state.unit);
  const [name, setName] = useState<string>(food.name);
  const [category, setCategory] = useState<string>(food.category);
  /** 每 100g 热量：输入框按当前单位回显，提交时再换算回 kcal 真值（口径不变，同 MealPortionEditor）。 */
  const [kcal, setKcal] = useState<string>(() => String(toDisplayEnergy(food.kcalPer100g, unit)));
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = 'edit-food-title';

  // 打开即聚焦名称输入框（与 SaveComboDialog 一致）。
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Esc 关闭（全站弹窗一致）。提交中不响应，避免打断在途请求。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  const submit = (): void => {
    if (busy) {
      return;
    }
    if (name.trim() === '') {
      setHint(COPY.myFoodsEditNameRequired);
      return;
    }
    const parsedKcal = Number(kcal);
    if (kcal.trim() === '' || !Number.isFinite(parsedKcal) || parsedKcal < 0) {
      setHint(COPY.myFoodsEditKcalRequired);
      return;
    }
    setHint(null);
    onSubmit({ name: name.trim(), category, kcalPer100g: fromDisplayEnergy(parsedKcal, unit) });
  };

  /** 就地提示（父级错误优先，其次本地提示）。 */
  const notice = errorText ?? hint;

  /**
   * 遮罩 + 容器。
   *
   * ## 为什么必须 `createPortal` 到 `document.body`（390×844 实测根因）
   *
   * `AppShell` 的 `<main>` 带 `animate-fade-in`，keyframes 含 `transform`。
   * 祖先只要 `transform` 计算值不为 `none`（哪怕停在 `translateY(0)`），就是
   * `position: fixed` 后代的**包含块**；同时它还造出一个**层叠上下文**，把弹层的
   * `z-50` 困在 `<main>` 内部 —— `<main>` 的兄弟 `<header>`（sticky，`z-30`）
   * 于是反压过弹层。
   *
   * 本页实测（`/settings/foods`，`<main>` 高仅 288，因为内容短）：
   * - 弹层被算成 `t=89 h=272`，**视口 844px 里只盖住 272px**；
   * - 面板被 `items-end` 推到 `t=-37`，**顶部 37px 在视口外**，标题行看不见；
   * - 弹层底边 `b=361`，**361–844 的 483px 背景裸露**（面板反而铺满弹层，
   *   视口内连一行遮罩都没有，压暗百分比无从采样）；
   * - 点 (195,60) 命中原页面 `<header>`，**不是** `role=dialog` → 点击穿透。
   *
   * `createPortal` 到 `body` 同时解决两件事：`fixed` 恢复相对视口、`z-50` 恢复可与
   * header 的 `z-30` 比较。**这是根因修复，不是视觉微调。**
   *
   * 遮罩两套取值沿用 `47f59ad` 实测口径：浅 `slate-900/50`、深 `slate-950/65`
   * （深色底本身已暗，必须另给一套且更深，否则压不出浮起感）。
   */
  const dialog = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="edit-food-dialog"
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 dark:bg-slate-950/65 sm:items-center sm:p-4"
    >
      <div className="max-h-[88vh] w-full max-w-lg animate-fade-in overflow-y-auto rounded-t-sheet bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-qsh-3 motion-reduce:transition-none dark:bg-slate-800 sm:rounded-sheet sm:pb-5">
        <div className="flex items-center justify-between">
          <h2 id={titleId} className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">
            {COPY.myFoodsEditTitle}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-testid="edit-food-close"
            className="qsh-touch-target rounded-control px-3 text-sm text-slate-500 transition duration-qsh-base ease-qsh-out disabled:opacity-60 dark:text-slate-400"
            aria-label="关闭编辑面板"
          >
            关闭
          </button>
        </div>

        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{COPY.myFoodsEditDesc}</p>

        <label className="mt-4 block text-sm text-slate-600 dark:text-slate-300">
          {COPY.myFoodsEditNameLabel}
          <input
            ref={inputRef}
            type="text"
            value={name}
            data-testid="edit-food-name"
            onChange={(event) => {
              setName(event.target.value);
              if (hint !== null) {
                setHint(null);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            aria-label={COPY.myFoodsEditNameLabel}
            className="mt-1 w-full rounded-control border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>

        <label className="mt-3 block text-sm text-slate-600 dark:text-slate-300">
          {COPY.myFoodsEditCategoryLabel}
          <select
            value={category}
            data-testid="edit-food-category"
            onChange={(event) => setCategory(event.target.value)}
            aria-label={COPY.myFoodsEditCategoryLabel}
            className="mt-1 w-full rounded-control border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          >
            {FOOD_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {foodCategoryLabel(item)}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-3 block text-sm text-slate-600 dark:text-slate-300">
          {COPY.myFoodsEditKcalLabel(unit)}
          <input
            type="number"
            inputMode="decimal"
            min={0}
            value={kcal}
            data-testid="edit-food-kcal"
            onChange={(event) => {
              setKcal(event.target.value);
              if (hint !== null) {
                setHint(null);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            aria-label={COPY.myFoodsEditKcalLabel(unit)}
            className="mt-1 w-full rounded-control border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>

        {notice !== null && (
          <p
            role="status"
            data-testid="edit-food-notice"
            className="mt-3 rounded-control bg-brand-50 px-3 py-2 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
          >
            {notice}
          </p>
        )}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            data-testid="edit-food-save"
            className="qsh-touch-target flex-1 rounded-control bg-brand-600 py-3 font-medium text-white transition duration-qsh-base ease-qsh-out hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? COPY.myFoodsEditBusy : COPY.myFoodsEditSave}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-testid="edit-food-cancel"
            className="qsh-touch-target rounded-control bg-brand-50 px-4 text-sm text-brand-700 transition duration-qsh-base ease-qsh-out disabled:opacity-60 dark:bg-brand-900/40 dark:text-brand-200"
          >
            {COPY.myFoodsEditCancel}
          </button>
        </div>
      </div>
    </div>
  );

  // 挂到 body：脱离 <main> 的 transform 包含块与层叠上下文（详见 dialog 注释）
  return createPortal(dialog, document.body);
}
