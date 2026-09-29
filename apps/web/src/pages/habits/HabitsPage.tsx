import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isNetworkError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { COPY, habitRestartAria, habitStopAria } from '@/lib/copy';
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
 *
 * GAP-11：误建的习惯可以**先停一停**（不是删除 —— 历史打卡全部保留），
 * 停掉的习惯收进底部「先停下来的」区域，随时可以**重新开始**。
 * - 后端 `GET /habits` **不过滤** `isActive`（返回全部，含停用项），由本页分区显示；
 * - 只有**自建**习惯（`isBuiltin === false`）才显示停用入口 —— 内置模板停用会 404；
 * - 停用 / 重新开始按钮是打卡按钮的**平级兄弟**（绝不嵌套 `<button>`，见下方注释）。
 */

interface HabitItem {
  id: number;
  code: string;
  name: string;
  icon: string | null;
  targetPerDay: number;
  isActive: boolean;
  /**
   * 是否内置全局模板（后端派生 = `userId === null`）。
   *
   * 内置模板不可停用（会影响所有用户，后端返回 404），故**不显示**停用按钮。
   * 兼容旧响应：缺失时按「自建」（`false`）处理（`!habit.isBuiltin` 为真）。
   */
  isBuiltin: boolean;
  doneToday: boolean;
  currentStreak: number;
  bestStreak: number;
  /** 近 35 天已打卡日期（升序）；缺失时按空数组渲染（兼容旧响应） */
  recentDates?: string[];
}

/** 「先停一停 / 重新开始」的目标状态载荷。 */
interface SetActiveVars {
  id: number;
  isActive: boolean;
}

export default function HabitsPage(): ReactElement {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string>('');
  const [newName, setNewName] = useState<string>('');
  /** 「先停下来的」区域是否展开（默认收起，让页面更安静）。 */
  const [showStopped, setShowStopped] = useState<boolean>(false);

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

  /**
   * 停用（`isActive:false`）/ 重新开始（`isActive:true`）—— 同一路由、同一 mutation。
   *
   * `PATCH /habits/:id` 的 `isActive` 是**必填**（后端 DTO 校验），这里始终显式传布尔值，
   * 绝不依赖任何「不传就当停用」的默认。
   */
  const setActive = useMutation({
    mutationFn: (vars: SetActiveVars) => api.patch<HabitItem>(`/habits/${vars.id}`, { isActive: vars.isActive }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.habits });
      setNotice(result.isActive ? COPY.habitRestartedNotice : COPY.habitStoppedNotice);
    },
    onError: (error: unknown) => {
      setNotice(isNetworkError(error) ? COPY.offlineNotice : COPY.habitUpdateMissed);
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

  // 分区：主列表只放「没停用的」；停掉的收进底部区域（后端不过滤，分区是前端职责）。
  // 用 `!== false` 而非 `=== true`：旧响应缺 isActive 时视作「可打卡的」更安全。
  const activeHabits = habits.filter((habit) => habit.isActive !== false);
  const stoppedHabits = habits.filter((habit) => habit.isActive === false);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pb-24 pt-4" aria-live="polite">
      {/* 页面语义标题：顶栏已显示「习惯打卡」，这里只补一个 h1 供辅助技术定位页面主题，
          不重复视觉层级 —— 本页此前没有任何标题元素（其余页面都自带 h1/h2）。 */}
      <h1 className="qsh-sr-only">习惯打卡</h1>

      {activeHabits.map((habit) => (
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
            data-testid={`habit-check-${habit.id}`}
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

          {/*
            「先停一停」入口（GAP-11）：
            - ⚠️ 它是上方打卡 `<button>` 的**平级兄弟**（包在独立的 `<div>` 里），**绝不嵌套** ——
              嵌套 `<button>` 是非法 HTML，读屏会读乱（GAP-1 收藏按钮踩过同一个坑）；
              这里额外加 `event.stopPropagation()`，双保险避免点它触发外层的打卡逻辑。
            - **内置习惯不显示**（`!habit.isBuiltin`）：内置模板停用会 404（影响所有用户），
              给它按钮等于让用户点了必然「没反应」。
            - 样式沿用全站「条目级操作」惯例：文字按钮、静止态非红（`text-slate-600`）、hover 才 coral。
          */}
          {!habit.isBuiltin && (
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                data-testid={`habit-stop-${habit.id}`}
                className="qsh-touch-target shrink-0 rounded-control px-2 text-xs text-slate-600 hover:text-coral-600 disabled:opacity-40 dark:text-slate-300"
                aria-label={habitStopAria(habit.name)}
                disabled={setActive.isPending}
                onClick={(event) => {
                  event.stopPropagation();
                  setActive.mutate({ id: habit.id, isActive: false });
                }}
              >
                {COPY.habitStop}
              </button>
            </div>
          )}

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

      {/*
        「先停下来的」区域（GAP-11）—— 只有存在停用项时才渲染（避免空区域变成提醒）。
        默认**收起**（更安静、不把「停了什么」摆在眼前），展开后才显示可「重新开始」的条目。
        文案不做计数、不评判，只把「怎么回来」讲清楚。
      */}
      {stoppedHabits.length > 0 && (
        <section className="qsh-surface p-4">
          <button
            type="button"
            data-testid="habit-stopped-toggle"
            className="qsh-touch-target rounded-control px-1 text-sm font-medium text-slate-700 hover:text-coral-600 dark:text-slate-200"
            aria-expanded={showStopped}
            onClick={() => setShowStopped((current) => !current)}
          >
            {showStopped ? COPY.habitStoppedHide : COPY.habitStoppedShow}
          </button>
          {showStopped && (
            <>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{COPY.habitStoppedSectionHint}</p>
              <ul className="mt-3 space-y-2" aria-label={COPY.habitStoppedSectionTitle}>
                {stoppedHabits.map((habit) => (
                  <li
                    key={habit.id}
                    data-testid={`habit-stopped-${habit.id}`}
                    className="flex items-center gap-3 rounded-control px-3 py-2 ring-1 ring-brand-100 dark:ring-slate-700"
                  >
                    <span className="text-xl" aria-hidden="true">
                      {habit.icon ?? '✅'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-slate-100">
                      {habit.name}
                    </span>
                    <button
                      type="button"
                      data-testid={`habit-restart-${habit.id}`}
                      className="qsh-touch-target shrink-0 rounded-control px-2 text-xs text-slate-600 hover:text-coral-600 disabled:opacity-40 dark:text-slate-300"
                      aria-label={habitRestartAria(habit.name)}
                      disabled={setActive.isPending}
                      onClick={() => setActive.mutate({ id: habit.id, isActive: true })}
                    >
                      {COPY.habitRestart}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

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
