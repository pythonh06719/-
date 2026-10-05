import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WinLog } from '@qsh/shared-types';
import { checkWinText, WIN_TEXT_MAX_LENGTH } from '@qsh/core';
import { api, ApiClientError, isNetworkError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { formatMonthDay, todayKey } from '@/lib/format';
import { COPY, winDateLine, winDeleteAria } from '@/lib/copy';
import { enqueueRequest } from '@/pwa/offline-queue';

/** 时间线回看窗口（K23：窗口语义是「最近」；上限 200 条由服务端保证）。 */
const WINS_WINDOW_DAYS = 90;

/**
 * 「体重之外的变化」卡（pages/weight/WinLogCard.tsx，R11.4）。
 *
 * **零压力入口（AC-11.4.1）**：
 * - 输入框**完全可选** —— 无必填校验、无字数下限、无每日提醒；
 * - 失焦且未输入 → **静默无反馈**（不报错、不 toast、不变红）；
 * - 只记今天：无日期选择器，`loggedDate` 完全由服务端生成（K21 / QR-5）；
 * - 删除无二次确认（AC-11.4.4），播报「已经删掉了」；
 * - 超过 {@link WIN_TEXT_MAX_LENGTH} 字给中性说明「最多能写 60 个字」（不阻断输入，提交时拦截）；
 * - 离线：写操作入 `enqueueRequest`（path `/wins`），提示「已经记下啦（还没同步）」（AC-11.4.9）；
 * - **禁止** 徽章 / 成就 / 等级 / 积分 / 连续 / 奖励 / 解锁 / 星级（AC-11.4.5），
 *   也不显示「已累计 N 条」—— 唯一计数出口在阶段回顾页（AC-11.4.6 / K22）。
 */
export default function WinLogCard(): ReactElement {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const winsQuery = useQuery({
    queryKey: queryKeys.wins(WINS_WINDOW_DAYS),
    queryFn: () => api.get<WinLog[]>('/wins', { days: WINS_WINDOW_DAYS }),
    retry: 0,
  });

  /**
   * 失焦：**刻意什么都不做** —— 失焦且未输入 → 静默无反馈（不报错、不 toast、不变红，
   * AC-11.4.1）。这里连状态都不记，避免将来有人"顺手"加个校验提示。
   */
  const handleBlur = (): void => {
    setNotice((current) => (current === COPY.winCardTooLong ? null : current));
  };

  /** 输入超限的中性说明（不阻断输入，提交时才拦截）。单次求值 + 判别联合收窄。 */
  const checkedForLimit = checkWinText(text);
  const overLimit = !checkedForLimit.ok && checkedForLimit.reason === 'tooLong';

  const createMutation = useMutation({
    mutationFn: async (cleanText: string): Promise<void> => {
      await api.post<WinLog>('/wins', { text: cleanText });
    },
    onSuccess: () => {
      setText('');
      setNotice(COPY.winCardSaved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.wins(WINS_WINDOW_DAYS) });
    },
    onError: (error, variables) => {
      if (isNetworkError(error)) {
        // 离线：入队 + 本地先展示一条临时记录（同步后会被真实数据替换）。
        // ⚠️ 必须用 **`variables`（本次提交的正文）** 而不是 `text` 状态：请求失败是异步的，
        // 用户很可能已改了输入框 —— 用 `text` 会把「后改的内容」当成「刚才提交的内容」入队/展示。
        void enqueueRequest({ path: '/wins', method: 'POST', body: { text: variables } });
        const now = new Date();
        const temp: WinLog = {
          id: -now.getTime(),
          userId: 0,
          loggedDate: todayKey(now),
          text: variables,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        queryClient.setQueryData<WinLog[]>(queryKeys.wins(WINS_WINDOW_DAYS), (previous) => [
          ...(previous ?? []),
          temp,
        ]);
        setText('');
        setNotice(COPY.winCardOfflineSaved);
        return;
      }
      if (error instanceof ApiClientError) {
        setNotice(error.fields?.text ?? error.message);
        return;
      }
      setNotice(COPY.winCardTooLong);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number): Promise<void> => {
      await api.delete<{ deleted: true }>(`/wins/${id}`);
    },
    onSuccess: (_data, id) => {
      setNotice(COPY.winCardDeleted);
      queryClient.setQueryData<WinLog[]>(queryKeys.wins(WINS_WINDOW_DAYS), (previous) =>
        (previous ?? []).filter((win) => win.id !== id),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.wins(WINS_WINDOW_DAYS) });
    },
    onError: (error, id) => {
      if (isNetworkError(error)) {
        // 离线删除：入队 + 本地先移除（无二次确认，AC-11.4.4）
        void enqueueRequest({ path: `/wins/${id}`, method: 'DELETE' });
        queryClient.setQueryData<WinLog[]>(queryKeys.wins(WINS_WINDOW_DAYS), (previous) =>
          (previous ?? []).filter((win) => win.id !== id),
        );
        setNotice(COPY.winCardDeleted);
        return;
      }
      // 业务错误（如记录已被删 / 不存在）：**不能再静默**（用户以为删掉了却还在），
      // 给一句中性陈述；不用「失败 / 错误」作标题、不用红色警示语义（PRD §7）。
      setNotice(COPY.winCardDeleteFailed);
    },
  });

  /** 提交：空 → 静默忽略（不提交、不提示）；超限 → 拦截并给中性说明。 */
  const handleSubmit = (): void => {
    setNotice(null);
    const checked = checkWinText(text);
    if (!checked.ok) {
      // 清洗后为空 → 静默忽略不提交（AC-11.4.1）；这里不做任何负反馈
      if (checked.reason === 'empty') {
        setText('');
        return;
      }
      setNotice(COPY.winCardTooLong);
      return;
    }
    createMutation.mutate(checked.text);
  };

  // 防御：响应形态异常（如离线队列回放的旧缓存 / 测试桩通用返回）时按空列表处理，不让整页崩
  const wins = Array.isArray(winsQuery.data) ? winsQuery.data : [];
  const today = todayKey();

  return (
    <section className="qsh-surface p-5" aria-labelledby="win-log-title">
      <h2 id="win-log-title" className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">
        {COPY.winCardTitle}
      </h2>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{COPY.winCardDesc}</p>

      <label className="mt-3 block text-sm text-slate-600 dark:text-slate-300">
        <span className="sr-only">{COPY.winCardInputLabel}</span>
        <input
          type="text"
          value={text}
          maxLength={200}
          placeholder={COPY.winCardPlaceholder}
          onChange={(event) => setText(event.target.value)}
          onBlur={handleBlur}
          data-testid="win-input"
          className="w-full rounded-control border border-brand-100 px-3 py-2 dark:border-slate-600 dark:text-slate-100"
        />
      </label>
      {overLimit && (
        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400" data-testid="win-too-long">
          {COPY.winCardTooLong}
        </p>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={createMutation.isPending}
        data-testid="win-submit"
        className="qsh-touch-target mt-3 w-full rounded-control bg-brand-600 py-3 font-medium text-white transition duration-qsh-base ease-qsh-out hover:bg-brand-700 disabled:opacity-60 dark:bg-brand-500 dark:hover:bg-brand-400"
      >
        {COPY.winCardSubmit}
      </button>

      {notice !== null && (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-brand-700 dark:text-brand-300" data-testid="win-notice">
          {notice}
        </p>
      )}

      <div className="mt-4">
        <h3 className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">{COPY.winCardListTitle}</h3>
        {winsQuery.isLoading ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">读取中…</p>
        ) : winsQuery.isError && wins.length === 0 ? (
          // 读取失败且无缓存可展示 → 「读不到」，**不能**说成「还没有记过」（语义完全相反）
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400" data-testid="win-list-error">
            {COPY.winCardListError}
          </p>
        ) : wins.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{COPY.winCardListEmpty}</p>
        ) : (
          <ul className="mt-2 space-y-2" aria-label={COPY.winCardTitle}>
            {wins.map((win) => (
              <li
                key={win.id}
                data-testid={`win-item-${win.id}`}
                className="flex items-start justify-between gap-3 rounded-control px-3 py-2 ring-1 ring-brand-100 dark:ring-slate-700"
              >
                <div className="min-w-0">
                  <p className="break-words text-sm text-slate-800 dark:text-slate-100">{win.text}</p>
                  <p className="qsh-tnum mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {winDateLine(win.loggedDate, today, formatMonthDay)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate(win.id)}
                  aria-label={winDeleteAria(win.text)}
                  data-testid={`win-delete-${win.id}`}
                  className="qsh-touch-target shrink-0 rounded-control px-2 text-xs text-slate-600 hover:text-coral-600 disabled:opacity-40 dark:text-slate-300"
                >
                  删掉这条
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
