import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isNetworkError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { COPY } from '@/lib/copy';
import { todayKey } from '@/lib/format';
import EmptyState from '@/components/common/EmptyState';
import HabitCalendar from './HabitCalendar';

/**
 * 习惯打卡（`/habits`，PRD §6 第 7 行 / R7.3 / R7.4，二期）。
 *
 * **无负罪感设计（硬性）**：只展示「当前连续 / 历史最佳」两个数字，
 * 断签**不惩罚、不清零提示、不发通知**，文案一律鼓励式。
 *
 * C3：每个习惯多一张「连续日历」（7×5 网格 = 近 35 天），把打卡日期明细摊开展示；
 * 断签一律空心浅色，不出现红叉 / 「已断 N 天」/ 任何惩罚性表述。
 */

interface HabitItem {
  id: number;
  code: string;
  name: string;
  icon: string | null;
  targetPerDay: number;
  isActive: boolean;
  doneToday: boolean;
  currentStreak: number;
  bestStreak: number;
  /** 近 35 天已打卡日期（升序）；缺失时按空数组渲染（兼容旧响应） */
  recentDates?: string[];
}

export default function HabitsPage(): ReactElement {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string>('');
  const [newName, setNewName] = useState<string>('');

  const habitsQuery = useQuery({
    queryKey: queryKeys.habits,
    queryFn: () => api.get<{ today: string; habits: HabitItem[] }>('/habits'),
    retry: 0,
  });

  const toggle = useMutation({
    mutationFn: (habit: HabitItem) =>
      api.post<{ checked: boolean }>(`/habits/${habit.id}/check`, { done: !habit.doneToday }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.habits });
      setNotice(result.checked ? COPY.habitChecked : COPY.habitUnchecked);
    },
    onError: (error: unknown) => {
      setNotice(isNetworkError(error) ? COPY.offlineNotice : '刚才没点上，再试一次就好');
    },
  });

  const createHabit = useMutation({
    mutationFn: (name: string) => api.post<HabitItem>('/habits', { code: `custom_${Date.now()}`, name }),
    onSuccess: () => {
      setNewName('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.habits });
      setNotice('新习惯加上了，不着急，慢慢来');
    },
    onError: (error: unknown) => {
      setNotice(isNetworkError(error) ? COPY.offlineNotice : '没创建成功，再试一次就好');
    },
  });

  const habits = habitsQuery.data?.habits ?? [];
  const today = habitsQuery.data?.today ?? todayKey();

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pb-24 pt-4" aria-live="polite">
      {/* 页面语义标题：顶栏已显示「习惯打卡」，这里只补一个 h1 供辅助技术定位页面主题，
          不重复视觉层级 —— 本页此前没有任何标题元素（其余页面都自带 h1/h2）。 */}
      <h1 className="qsh-sr-only">习惯打卡</h1>

      {habits.map((habit) => (
        <div
          key={habit.id}
          className={`rounded-2xl p-5 shadow-sm transition-all ${
            habit.doneToday
              ? 'bg-brand-50 ring-2 ring-brand-300 dark:bg-brand-900/40'
              : 'bg-white dark:bg-slate-800'
          }`}
        >
          <button
            type="button"
            className="flex w-full items-center gap-4 text-left"
            onClick={() => toggle.mutate(habit)}
            aria-pressed={habit.doneToday}
            aria-label={`${habit.name}，${habit.doneToday ? '今天已打卡' : '今天还没打卡'}`}
          >
            <span className="text-2xl" aria-hidden="true">
              {habit.icon ?? '✅'}
            </span>
            <span className="flex-1">
              <span className="block font-medium text-slate-800 dark:text-slate-100">{habit.name}</span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                当前连续 {habit.currentStreak} 天 · 历史最佳 {habit.bestStreak} 天
              </span>
            </span>
            <span
              className={`flex h-8 w-8 items-center justify-center rounded-full text-lg ${
                habit.doneToday ? 'bg-brand-600 text-white' : 'border border-slate-300 dark:border-slate-500'
              }`}
              aria-hidden="true"
            >
              {habit.doneToday ? '✓' : ''}
            </span>
          </button>
          <HabitCalendar checkedDates={habit.recentDates ?? []} today={today} />
        </div>
      ))}

      {/*
        ⚠️ 正常路径下本分支**不可达**：`GET /api/habits` 对所有账号都返回同一批种子习惯
        （water / early_sleep / steps…），`habits.length` 恒 > 0。
        实际只有**请求失败**时（`data` 为 undefined → `habits` 退回 `[]`）才会渲染到这里 ——
        而那时显示「还没有习惯」其实并不准确（是出错，不是空）。
        保留 `EmptyState` 是把它当**防御性展示**：真有一天出现「零习惯」的账号，
        这里至少不是一句裸文案。若将来后端改成按用户返回，本处会自然生效。
        真正可达的空状态见 exercise / weight / diary 三处。
      */}
      {habits.length === 0 ? (
        habitsQuery.isLoading ? (
          <p className="rounded-2xl bg-white p-6 text-center text-sm text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-400">
            正在取回你的习惯…
          </p>
        ) : (
          <EmptyState title="还没有习惯，从下面加一个开始吧" />
        )
      ) : null}

      <form
        className="qsh-surface p-5"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = newName.trim();
          if (trimmed.length > 0) {
            createHabit.mutate(trimmed);
          }
        }}
      >
        <label className="block text-sm text-slate-600 dark:text-slate-300" htmlFor="new-habit">
          加一个自己的习惯
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="new-habit"
            className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-slate-800 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            value={newName}
            maxLength={30}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="比如：睡前拉伸"
          />
          <button
            type="submit"
            className="rounded-xl bg-brand-600 px-4 py-2 font-medium text-white disabled:opacity-50"
            disabled={createHabit.isPending}
          >
            添加
          </button>
        </div>
      </form>

      <p className="text-center text-xs text-slate-600 dark:text-slate-400">{COPY.streakPositive}</p>
      {notice ? <p className="text-center text-sm text-brand-700 dark:text-brand-400">{notice}</p> : null}
    </div>
  );
}
