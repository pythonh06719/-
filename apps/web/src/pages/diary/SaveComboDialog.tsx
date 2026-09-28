import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { COPY } from '@/lib/copy';
import { MEAL_TYPE_LABELS } from './meal-utils';

/**
 * 「存成套餐」命名弹窗（pages/diary/SaveComboDialog.tsx，R3.9 / GAP-2）。
 *
 * 用户在某餐点「存成套餐」后弹出，给这一餐起个名字。交互刻意保持最简：
 * - **只做命名**，明细就是这一餐已记录的条目（父组件负责映射与提交）；
 * - 🔴 **不展示任何合计热量 / 条数统计**（架构设计 Q-2）：本功能不产生新数字，
 *   弹窗只出现餐次名、条目**名称列表**、一个名字输入框，彻底规避 NFR-11 可解释性问题；
 * - 提交中禁用按钮，防重复提交；
 * - 名称未填时给中性提示且**不发请求**（与快加卡同风格）；
 * - 409 同名 / 其它错误由父组件通过 `errorText` 就地展示，弹窗**不关闭**、保留已填名字，
 *   让用户改一个字就能重提交（温和提供选择，不是纠正错误）。
 *
 * ## UI 规范自检（`docs/VISUAL-SYSTEM.md`，对齐 `MealPortionEditor.tsx`）
 * - 触控：所有按钮与输入框一律 `qsh-touch-target`（≥44×44）；
 * - 圆角 / 动效：用语义令牌 `rounded-control` / `duration-qsh-base` + `ease-qsh-out`；
 * - 对比度：12px（`text-xs`）文字统一 `slate-600` / `dark:slate-300`；
 * - 状态：禁用用 `disabled:opacity-60` 保留控件；错误提示只给一句中性话，**不用红色恐吓**。
 * - 无障碍：`role="dialog"` + `aria-modal` + `aria-labelledby` 关联标题；Esc 关闭；打开时自动聚焦输入框。
 */

export interface SaveComboDialogProps {
  /** 正在存的餐次（用于标题关联与默认名，展示用） */
  mealType: keyof typeof MEAL_TYPE_LABELS;
  /** 该餐已记录的条目（只用于展示条目名称列表，**不展示热量**） */
  itemNames: readonly string[];
  /** 输入框初值（父组件用 `comboDefaultName(...)` 生成） */
  defaultName: string;
  /** 是否正在提交（为真时禁用按钮，防重复提交） */
  busy: boolean;
  /** 就地错误提示（409 同名 / 离线 / 失败）；`null` = 不展示 */
  errorText: string | null;
  /** 关闭弹窗（不保存） */
  onCancel: () => void;
  /** 提交命名（父组件负责 POST / 缓存刷新 / 播报） */
  onSubmit: (name: string) => void;
}

export default function SaveComboDialog({
  mealType,
  itemNames,
  defaultName,
  busy,
  errorText,
  onCancel,
  onSubmit,
}: SaveComboDialogProps): ReactElement {
  const [name, setName] = useState<string>(defaultName);
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = 'save-combo-title';

  // 打开即聚焦输入框：用户可「看一眼默认名 → 直接回车」完成保存。
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Esc 关闭（与全站弹窗一致）。提交中不响应，避免打断在途请求。
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
      setHint(COPY.comboNameRequired);
      return;
    }
    setHint(null);
    onSubmit(name.trim());
  };

  /** 输入变化时清掉「没填名字」的中性提示（用户开始改了就不必再说）。 */
  const changeName = (value: string): void => {
    setName(value);
    if (hint !== null) {
      setHint(null);
    }
  };

  /** 就地错误提示（父组件传入）；与本地 hint 不同时出现，优先展示父级错误。 */
  const notice = errorText ?? hint;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4"
    >
      <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-qsh-3 dark:bg-slate-800 sm:rounded-3xl">
        <div className="flex items-center justify-between">
          <h2 id={titleId} className="text-base font-semibold text-slate-800 dark:text-slate-100">
            {COPY.comboSaveTitle}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="qsh-touch-target rounded-control px-3 text-sm text-slate-500 transition duration-qsh-base ease-qsh-out disabled:opacity-60 dark:text-slate-400"
            aria-label="关闭存套餐面板"
          >
            关闭
          </button>
        </div>

        <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">
          {MEAL_TYPE_LABELS[mealType]}
        </p>
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{COPY.comboSaveDesc}</p>

        {/* 条目名称列表：只列名字，**不出现任何热量 / 条数统计**（Q-2） */}
        {itemNames.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {itemNames.map((itemName, index) => (
              <li
                key={`${itemName}-${index}`}
                className="rounded-full bg-brand-50 px-2.5 py-1 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300"
              >
                {itemName}
              </li>
            ))}
          </ul>
        )}

        <label className="mt-4 block text-sm text-slate-600 dark:text-slate-300">
          {COPY.comboNameLabel}
          <input
            ref={inputRef}
            type="text"
            value={name}
            placeholder={COPY.comboNamePlaceholder}
            onChange={(event) => changeName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            aria-label={COPY.comboNameLabel}
            className="mt-1 w-full rounded-control border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>

        {notice !== null && (
          <p
            role="status"
            data-testid="save-combo-notice"
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
            className="qsh-touch-target flex-1 rounded-control bg-brand-600 py-3 font-medium text-white transition duration-qsh-base ease-qsh-out hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? '正在存…' : COPY.comboSaveConfirm}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="qsh-touch-target rounded-control bg-brand-50 px-4 text-sm text-brand-700 transition duration-qsh-base ease-qsh-out disabled:opacity-60 dark:bg-brand-900/40 dark:text-brand-200"
          >
            {COPY.comboSaveCancel}
          </button>
        </div>
      </div>
    </div>
  );
}
