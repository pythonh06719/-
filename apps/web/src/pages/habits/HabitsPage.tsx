import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isNetworkError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { COPY } from '@/lib/copy';

/**
 * 习惯打卡（`/habits`，PRD §6 第 7 行 / R7.3 / R7.4，二期）。
 *
 * **无负罪感设计（硬性）**：只展示「当前连续 / 历史最佳」两个数字，
 * 断签**不惩罚、不清零提示、不发通知**，文案一律鼓励式。
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

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pb-24 pt-4" aria-live="polite">
      {habits.map((habit) => (
        <button
          key={habit.id}
          type="button"
          className={`flex items-center gap-4 rounded-2xl p-5 text-left shadow-sm transition-all ${
            habit.doneToday
              ? 'bg-teal-50 ring-2 ring-teal-300 dark:bg-teal-900/40'
              : 'bg-white dark:bg-slate-800'
          }`}
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
              habit.doneToday ? 'bg-teal-500 text-white' : 'border border-slate-300 dark:border-slate-500'
            }`}
            aria-hidden="true"
          >
            {habit.doneToday ? '✓' : ''}
          </span>
        </button>
      ))}

      {habits.length === 0 ? (
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-400">
          {habitsQuery.isLoading ? '正在取回你的习惯…' : '还没有习惯，从下面加一个开始吧'}
        </p>
      ) : null}

      <form
        className="rounded-2xl bg-white p-5 shadow-sm dark:bg-slate-800"
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
            className="rounded-xl bg-teal-600 px-4 py-2 font-medium text-white disabled:opacity-50"
            disabled={createHabit.isPending}
          >
            添加
          </button>
        </div>
      </form>

      <p className="text-center text-xs text-slate-600 dark:text-slate-400">{COPY.streakPositive}</p>
      {notice ? <p className="text-center text-sm text-teal-700 dark:text-teal-400">{notice}</p> : null}
    </div>
  );
}
