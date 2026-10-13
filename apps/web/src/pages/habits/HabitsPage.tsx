import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isNetworkError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { COPY, habitRestartAria, habitStopAria } from '@/lib/copy';
import { todayKey } from '@/lib/format';
import EmptyState from '@/components/common/EmptyState';
import StateBlock from '@/components/common/StateBlock';
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
 *
 * **三态表达（本页对 `GET /habits` 的唯一判据口径）**：列表区的状态是
 * 「加载中 / 取数失败 / 真的没有习惯」**三者互斥**，判据取自查询本身
 * （`isLoading` / `isError`），**不取自 `habits.length`** —— 见下方三分支处的注释。
 */

/**
 * 本页私有文案（不进 `lib/copy.ts`）。
 *
 * 为什么不并到 `COPY`：这几句只在**本文件这一处**用到，`COPY` 的定位是跨页面共享
 * 口径的文案表（见该文件头说明）；单独入表反而会让「这一页为什么这么说」的理由
 * 离使用点更远。跨页面复用时再迁过去。
 */

/** 首次取数中的占位文案（不留裸白屏，也不把「还没取到」说成「你没有」） */
const HABITS_LOADING = '正在取回你的习惯…';
/**
 * 取数失败时的中性说明。
 *
 * ⚠️ 刻意**不归因**（不说「网络不稳」/「服务端出错」）：本页无法可靠区分一个 500
 * 与一次断网，归因不准会把用户引去查 WiFi —— 而问题可能在别处。只陈述现象 + 给一条出路。
 * ⚠️ 刻意**不含任何数字**：本页没有新数字要上屏（当前连续 / 历史最佳的口径已在
 * `/why-numbers` ㉕ 解释），失败态更不该凭空出现计数。
 */
const HABITS_LOAD_ERROR = '这一页暂时读不到你的习惯，稍后再来看看就好';
/** 失败态里唯一的人工出路：直接重跑本查询，取到数据后本条自动消失 */
const HABITS_LOAD_RETRY = '重新试试';
/** 真·空状态：**请求成功**且确实一条习惯都没有（与「失败」严格区分，见下方三分支） */
const HABITS_EMPTY = '还没有习惯，从下面加一个开始吧';
/** 打卡状态的读屏措辞（与可见样式无关，只进 `aria-label`） */
const HABIT_DONE_TODAY = '今天已打卡';
const HABIT_NOT_DONE_TODAY = '今天还没打卡';

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
   * 三个用途（同一个字段，别的地方也依赖它）：
   * 1. 内置模板不可停用（停用会 404，影响所有用户）→ 不显示停用按钮；
   * 2. 名字旁显示中性「内置」标注，让用户分得清哪个是自己建的（code 唯一性缺陷的展示层补丁）；
   * 3. 并入打卡按钮的 `aria-label`（因 `aria-label` 覆盖后代文本，读屏用户只靠这里获取该信息）。
   *
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

/**
 * 打卡按钮的**完整可访问名**。
 *
 * ⚠️ 为什么连项都要逐一拼进来：`<button>` 显式写了 `aria-label` 时，按 accname 规范
 * **`aria-label` 会覆盖全部后代文本** —— 名字、「内置」、以及下面那行「当前连续 / 历史最佳」
 * 统统听不到。而这两个数字正是**本页唯一有信息量的数值**（R7.3），缺了它们，
 * 读屏用户点的是一张只报「名字 + 有没有打卡」的按钮，等于把习惯打卡的全部反馈都丢掉了。
 *
 * 按本仓判据，`aria-hidden` 有**两种正当理由且不可混用**：
 * 「不承载信息」→ 直接 `aria-hidden`；「信息已在别处」→ **必须先把信息并进 `aria-label`**，
 * 可见副本才能 `aria-hidden`。这里走的是第二种（与「内置」span 同一思路）。
 *
 * 拼法是逐段相连、读出来是一句自然的话（不是堆成一长串术语）：
 * 「喝水达标，内置，今天已打卡，当前连续 3 天，历史最佳 7 天」。
 * 数字口径与可见那一行**逐字一致**（同一个 `${habit.currentStreak}`），
 * 避免读屏与肉眼两个版本打架。
 */
function buildHabitCheckAria(habit: HabitItem): string {
  const parts: string[] = [habit.name];
  if (habit.isBuiltin) {
    parts.push(COPY.habitBuiltinTag);
  }
  parts.push(habit.doneToday ? HABIT_DONE_TODAY : HABIT_NOT_DONE_TODAY);
  parts.push(`当前连续 ${habit.currentStreak} 天`);
  parts.push(`历史最佳 ${habit.bestStreak} 天`);
  return parts.join('，');
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
          className={`p-5 transition-colors duration-qsh-base ease-qsh-out ${
            // ⚠️ 已打卡态**刻意不用** `.qsh-surface`：该类是普通 CSS 规则且排在
            // `@tailwind utilities` 之后，同特异性下会盖掉 `bg-brand-50` / `ring-2`，
            // 「今天已打卡」的绿底与双线环就都没了。这里手写等价的一套（含 elevation token），
            // 未打卡态才用 `.qsh-surface`（深色底色由 dark.css 统一接管）。
            habit.doneToday
              ? 'rounded-card bg-brand-50 shadow-qsh-1 ring-2 ring-brand-300 dark:bg-brand-900/40'
              : 'qsh-surface'
          }`}
        >
          <button
            type="button"
            data-testid={`habit-check-${habit.id}`}
            className="flex w-full items-center gap-4 text-left"
            onClick={() => toggle.mutate(habit)}
            aria-pressed={habit.doneToday}
            /**
             * 打卡按钮的可访问名 —— 由 `buildHabitCheckAria` 统一拼装，理由见该函数的注释。
             *
             * 一句话版：**凡是被这个 `aria-label` 覆盖掉的后代信息，都必须在这里出现**。
             * 目前被它覆盖、因而**必须**并入这条 label 的三项：
             * ① 「内置」（`COPY.habitBuiltinTag`）—— 不写进这里 ⇒ 读屏用户永远分不清
             *    哪条是自己建的，而这正是本页要解决的核心困惑；
             * ② 「今天（没）打卡」；
             * ③ 「当前连续 / 历史最佳」—— 本页唯一的数值反馈。
             * 对应的可见元素因此都是**同一信息的视觉重复**，全部标 `aria-hidden`，
             * 以免浏览模式下被重复朗读成噪音。
             */
            aria-label={buildHabitCheckAria(habit)}
          >
            <span className="text-2xl" aria-hidden="true">
              {habit.icon ?? '✅'}
            </span>
            <span className="flex-1">
              {/*
                「内置」元信息标注（code 唯一性缺陷的展示层补丁）：

                ## 为什么需要它
                `code` 唯一只保证了**数据正确**（备份可恢复），但用户仍会看到
                内置的「喝水达标」与自己建的「喝水达标」两张长得几乎一样的卡，
                分不清哪个是自己建的。这个标注就是补上这条信息。

                ## 为什么是「中性小字」而不是「徽章」
                它是**元信息说明**，不是可操作项。若做成带底色/边框/圆角胶囊的徽章，
                视觉权重会与旁边的「先停一停」操作按钮争夺注意力 ——
                而**操作按钮的优先级必须高于「这条是内置的」这个事实说明**。
                故只用 `text-xs` + 中性灰，不引入新的圆角/边框 token
                （全站形态语言是「胶囊」与「卡片」两类，不为此加第三类）。

                ## 无障碍：为什么是 `aria-hidden`（详见 report）
                打卡 `<button>` 已有显式 `aria-label`（由 `buildHabitCheckAria` 拼装），
                **`aria-label` 会覆盖全部后代文本** —— 所以按钮本身朗读时
                「内置」不会被读出来。为了让读屏用户**真的拿到这条信息**，
                已把 `COPY.habitBuiltinTag` 并入该 `aria-label`；
                这里的可见 span 因此是**同一信息的视觉重复**，
                必须 `aria-hidden` 以免浏览模式下被重复朗读成噪音。
              */}
              <span className="flex items-baseline gap-1.5">
                <span className="font-medium text-slate-800 dark:text-slate-100">{habit.name}</span>
                {habit.isBuiltin && (
                  <span aria-hidden="true" className="text-xs text-slate-600 dark:text-slate-400">
                    {COPY.habitBuiltinTag}
                  </span>
                )}
              </span>
              {/*
                当前连续 / 历史最佳 —— 与本 span 对应的信息已由 `buildHabitCheckAria`
                并进上方 `<button>` 的 `aria-label`，所以这里是**同一信息的视觉重复**，
                必须 `aria-hidden`（否则浏览模式下会被念两遍：先整钮念一遍 label，走到
                这个 span 再念一遍数字）。这是本仓「信息已在别处」的第二种 aria-hidden 用法。
              */}
              <span aria-hidden="true" className="block text-xs text-slate-600 dark:text-slate-400">
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
            <div className="mt-tight flex justify-end">
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
        列表区的**三态**表达：加载中 / 取数失败 / 真的没有习惯 —— **三者互斥**。

        ## 为什么不能用 `habits.length` 当判据
        `habits` 是 `data?.habits ?? []`：请求失败时 `data` 为 undefined，`habits` 退回 `[]`，
        于是「失败」与「真空」在这一个数字上**完全无法区分**。合并成一个判据的后果是：
        一次 500 或一次断网，页面就对用户说「还没有习惯，从下面加一个开始吧」——
        那是**把「我没把数据取回来」说成「你还没开始」**。用户会以为自己记错了、
        跑到下面表单去重键一个同名习惯，而真实的习惯列表其实一直好好的。
        判据因此必须取自查询本身（`isLoading` / `isError`），长度只在最内层充当「列不列得出东西」。

        ## 为什么外层仍要 `habits.length === 0`
        已经有习惯可以列的时候（上一次成功的响应还在，`data` 未被清掉），
        下面再叠一条「读不到你的习惯」就与屏幕内容自相矛盾了 —— 那时本区块什么都不渲染。

        ## 为什么是「读不到」而不是「出错了」
        PRD §7：不指责、不焦虑 —— 说明文案刻意避开「错误 / 失败 / 异常」这类词，
        只陈述现象、不给**归因**（不说「网络不稳」也说「服务端出错」）：本页无法可靠
        区分一个 500 与一次断网，归因不准会把用户引去查 WiFi，而问题可能在别处。

        配色同 `[diary] stale-meals-notice`：`bg-slate-100 text-slate-600`，
        深色 `bg-slate-800 text-slate-300` —— 中性陈述，**不弹窗、不遮挡、不用红/警示色**。

        ## 出路同屏可达
        「重新试试」直接 `habitsQuery.refetch()`：取到数据后习惯列表自然出现、本条自动消失，
        不需要额外的成功/失败状态机（重取失败也只是停回本分支，不会退化成空状态）。
      */}
      {habits.length === 0 ? (
        habitsQuery.isLoading ? (
          <StateBlock>
            {HABITS_LOADING}
          </StateBlock>
        ) : habitsQuery.isError ? (
          <div
            role="status"
            data-testid="habits-load-error"
            className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-control bg-slate-100 px-4 py-2 text-caption text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          >
            <span>{HABITS_LOAD_ERROR}</span>
            <button
              type="button"
              data-testid="habits-load-retry"
              className="qsh-touch-target rounded-control px-2 py-1 font-medium text-brand-700 underline underline-offset-2 transition-colors duration-qsh-base ease-qsh-out disabled:opacity-60 dark:text-brand-300"
              disabled={habitsQuery.isFetching}
              onClick={() => {
                void habitsQuery.refetch();
              }}
            >
              {HABITS_LOAD_RETRY}
            </button>
          </div>
        ) : (
          <EmptyState title={HABITS_EMPTY} />
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
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">{COPY.habitStoppedSectionHint}</p>
              <ul className="mt-block space-y-2" aria-label={COPY.habitStoppedSectionTitle}>
                {stoppedHabits.map((habit) => (
                  <li
                    key={habit.id}
                    data-testid={`habit-stopped-${habit.id}`}
                    className="flex items-center gap-3 rounded-control px-3 py-2 ring-1 ring-brand-100 dark:ring-slate-700"
                  >
                    <span className="text-xl" aria-hidden="true">
                      {habit.icon ?? '✅'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-slate-100" title={habit.name}>
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
            className="flex-1 rounded-control border border-slate-200 px-3 py-2 text-slate-800 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            value={newName}
            maxLength={30}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="比如：睡前拉伸"
          />
          <button
            type="submit"
            className="rounded-control bg-brand-600 px-4 py-2 font-medium text-white transition-colors duration-qsh-fast ease-qsh-out disabled:opacity-50"
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
