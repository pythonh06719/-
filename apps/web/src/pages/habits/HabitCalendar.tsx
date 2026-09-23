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

  return (
    <figure className="mt-3">
      <figcaption className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {COPY.habitCalendarTitle}
      </figcaption>
      <div
        role="img"
        aria-label={habitCalendarAria(checkedCount)}
        className="mt-1.5 grid grid-cols-7 gap-1.5"
      >
        {columnLabels.map((label, column) => (
          <span
            key={`weekday-${column}`}
            aria-hidden="true"
            className="text-center text-[10px] text-slate-400 dark:text-slate-500"
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
              className={`aspect-square rounded-[5px] ${
                isChecked
                  ? 'bg-brand-500 dark:bg-brand-400'
                  : 'border border-slate-200 bg-slate-50 dark:border-slate-600 dark:bg-slate-700/40'
              }`}
            />
          );
        })}
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {checkedCount > 0 ? COPY.habitCalendarHint : COPY.habitCalendarEmpty}
      </p>
    </figure>
  );
}
