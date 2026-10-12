import { useState } from 'react';
import type { ReactElement } from 'react';
import { addDays, weekdayShort } from '@/lib/format';
import { COPY, habitCalendarAria } from '@/lib/copy';

/**
 * 习惯「连续日历」（pages/habits/HabitCalendar.tsx，C3）。
 *
 * 把原本被丢掉的打卡**日期明细**渲染成一张 7×5 网格（近 35 天 = 恰好 5 周）。
 *
 * **语气硬约束（PRD §7 无负罪感）**：
 * - 打过卡 = 实心品牌色；没打卡 = **空心浅色**（**不是**红叉、不是灰色「缺失」、不写「已断 N 天」）；
 * - 文案只用「哪天打了卡」的陈述 + 一句「歇一歇也很正常」，**不做任何惩罚性标注**；
 * - 无障碍只播报「有几天打了卡」，不播报断签天数（避免把留白读成缺失）。
 *
 * 列 = 星期几、行 = 周：35 天正好 5 周，因此每一列天然对应同一个星期几。
 *
 * 2026-10-12（UI 评审 P1-3 紧凑化）：**窗口内零打卡时默认折叠**。
 * 原状下每个没记录的习惯都摊出 35 个空格 + 标题 + 图例句 + 空态句共 5 行，
 * 6 个空习惯就是近 3000px 的重复滚动——新用户第一印象是「空且长」。
 * 折叠为一行摘要 + 「看看这 35 天」按钮；有点击记录后始终展开（记录是日历的存在理由）。
 * 手动折叠/展开过的习惯尊重用户选择，不随后台刷新翻跟头。
 */

/** 连续日历窗口长度（天）：7 列 × 5 行。 */
export const HABIT_CALENDAR_DAYS = 35;
/** 网格列数（一周 7 天）。 */
const COLUMNS = 7;

export interface HabitCalendarProps {
  /** 已打卡日期（`YYYY-MM-DD`，升序）；可空、可含窗口外日期（本组件按窗口过滤） */
  checkedDates: readonly string[];
  /** 今天（本地日期键 `YYYY-MM-DD`），窗口右端 */
  today: string;
}

export default function HabitCalendar({ checkedDates, today }: HabitCalendarProps): ReactElement {
  const checked = new Set(checkedDates);
  const windowStart = addDays(today, -(HABIT_CALENDAR_DAYS - 1));
  const cells = Array.from({ length: HABIT_CALENDAR_DAYS }, (_, index) => addDays(windowStart, index));
  const columnLabels = Array.from({ length: COLUMNS }, (_, column) =>
    weekdayShort(addDays(windowStart, column)),
  );
  const checkedCount = cells.filter((date) => checked.has(date)).length;

  /**
   * 展开态：`null` = 用户没表过态，跟随数据（有记录自动展开、零记录自动折叠）；
   * 非 `null` = 用户手动选过，尊重选择。用「三态」而不是 useEffect 同步，
   * 是为了让「数据刷新把用户手动折叠的日历重新摊开」这件事不可能发生。
   */
  const [manual, setManual] = useState<boolean | null>(null);
  const expanded = manual ?? checkedCount > 0;

  if (!expanded) {
    return (
      <div className="mt-block flex items-center justify-between gap-3">
        <p className="text-caption text-slate-500 dark:text-slate-400">{COPY.habitCalendarEmpty}</p>
        <button
          type="button"
          className="qsh-touch-target shrink-0 rounded-control px-2 text-caption font-medium text-brand-700 transition-colors duration-qsh-fast ease-qsh-out hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-slate-800"
          aria-expanded={false}
          onClick={() => setManual(true)}
        >
          {COPY.habitCalendarExpand}
        </button>
      </div>
    );
  }

  return (
    <figure className="mt-block">
      <div className="flex items-center justify-between gap-3">
        <figcaption className="text-caption font-medium text-slate-600 dark:text-slate-300">
          {COPY.habitCalendarTitle}
        </figcaption>
        {/* 只有零记录的折叠态才需要「收起来」——有记录的日历收起来会藏信息 */}
        {checkedCount === 0 && (
          <button
            type="button"
            className="qsh-touch-target shrink-0 rounded-control px-2 text-caption font-medium text-slate-600 transition-colors duration-qsh-fast ease-qsh-out hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-expanded
            onClick={() => setManual(false)}
          >
            {COPY.habitCalendarCollapse}
          </button>
        )}
      </div>
      <div
        role="img"
        aria-label={habitCalendarAria(checkedCount)}
        className="mt-1.5 grid grid-cols-7 gap-1.5"
      >
        {columnLabels.map((label, column) => (
          <span
            key={`weekday-${column}`}
            aria-hidden="true"
            className="text-center text-caption text-slate-500 dark:text-slate-400"
          >
            {label}
          </span>
        ))}
        {cells.map((date) => {
          const isChecked = checked.has(date);
          return (
            <span
              key={date}
              data-date={date}
              data-checked={isChecked ? 'true' : 'false'}
              aria-hidden="true"
              className={`aspect-square rounded-cell ${
                isChecked
                  ? 'bg-brand-500 dark:bg-brand-400'
                  : // 空心格用品牌色系（而非 slate-50）：白卡上 slate-50 与底色近乎同色，
                    // 网格「哪里是格」认不出。brand-50 + brand-100 细边保持轻，但不隐形。
                    'border border-brand-100 bg-brand-50/60 dark:border-slate-600 dark:bg-slate-700/40'
              }`}
            />
          );
        })}
      </div>
      <p className="mt-2 text-caption text-slate-600 dark:text-slate-300">
        {checkedCount > 0 ? COPY.habitCalendarHint : COPY.habitCalendarEmpty}
      </p>
    </figure>
  );
}
