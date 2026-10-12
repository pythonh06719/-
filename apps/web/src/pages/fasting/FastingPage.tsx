import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, isNetworkError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { COPY } from '@/lib/copy';

/**
 * 断食计时器（`/fasting`，PRD §6 第 9 行 / R8.1~R8.4，二期）。
 *
 * **安全设计（硬性）**：
 * - 默认关闭；首次开启**必须**先看内容警告并点「我知道了」（服务端强制 `disclaimerAckAt`，TC-30）
 * - 「这不适合我」是一级按钮，随时可退出
 * - 不做任何主动推送怂恿断食（R8.3）
 */

interface FastingSettings {
  plan: string;
  targetFastHours: number;
  eatWindowStart: string | null;
  enabled: boolean;
  disclaimerAckAt: string | null;
}

interface FastingSession {
  id: number;
  plan: string;
  targetHours: number;
  startedAt: string;
  endedAt: string | null;
  completed: boolean;
  elapsedHours: number;
  remainingHours: number;
}

/** 内容警告正文（含求助资源，R8.2）。 */
const CONTENT_WARNING = [
  '断食不适合所有人：孕期、哺乳期、正处于疾病治疗期、有饮食障碍史或正在服药的朋友，都不建议尝试。',
  '长时间不进食可能出现头晕、乏力、注意力下降等不适；出现不适请立即停止并进食。',
  '如果你或身边的人正在经历饮食困扰，可以寻求专业帮助（如当地精神卫生中心、心理援助热线）。',
];

export default function FastingPage(): ReactElement {
  const queryClient = useQueryClient();
  const [showWarning, setShowWarning] = useState<boolean>(false);
  const [notice, setNotice] = useState<string>('');

  const settingsQuery = useQuery({
    queryKey: queryKeys.fastingSettings,
    queryFn: () => api.get<FastingSettings>('/fasting/settings'),
    retry: 0,
  });

  const currentQuery = useQuery({
    queryKey: queryKeys.fastingCurrent,
    queryFn: () => api.get<FastingSession | null>('/fasting/current'),
    retry: 0,
  });

  const saveSettings = useMutation({
    mutationFn: (payload: Partial<FastingSettings> & { disclaimerAckAt?: string }) =>
      api.patch<FastingSettings>('/fasting/settings', payload),
    onSuccess: (data) => {
      void queryClient.setQueryData(queryKeys.fastingSettings, data);
      setShowWarning(false);
      setNotice(data.enabled ? '计时器已开启，随时可以停下' : '已关闭，这样也很好');
    },
    onError: (error: unknown) => {
      setNotice(isNetworkError(error) ? COPY.offlineNotice : '没设置成功，再试一次就好');
    },
  });

  const start = useMutation({
    mutationFn: () => api.post<FastingSession>('/fasting/start'),
    onSuccess: (data) => void queryClient.setQueryData(queryKeys.fastingCurrent, data),
    onError: (error: unknown) => setNotice(isNetworkError(error) ? COPY.offlineNotice : '没开始成功，再试一次就好'),
  });

  const stop = useMutation({
    mutationFn: () => api.post<FastingSession>('/fasting/stop'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.fastingCurrent });
      setNotice(COPY.fastingReminder);
    },
    onError: () => setNotice(COPY.fastingReminder),
  });

  const settings = settingsQuery.data;
  const session = currentQuery.data ?? null;

  /** 开启前必须先看内容警告（本地 gate + 服务端强制，双层）。 */
  const requestEnable = (): void => {
    setShowWarning(true);
  };

  const confirmEnable = (): void => {
    saveSettings.mutate({ enabled: true, disclaimerAckAt: new Date().toISOString() });
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pb-24 pt-4" aria-live="polite">
      {showWarning ? (
        <section className="rounded-card bg-coral-50 p-5 ring-2 ring-coral-200 dark:bg-coral-900/30 dark:ring-coral-700" role="alertdialog" aria-labelledby="fasting-warning-title">
          <h2 id="fasting-warning-title" className="text-subtitle font-bold text-coral-800 dark:text-coral-200">
            {COPY.fastingWarningTitle}
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-body text-coral-700 dark:text-coral-100">
            {CONTENT_WARNING.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              className="rounded-control border-2 border-coral-500 px-4 py-3 font-semibold text-coral-800 transition-colors duration-qsh-fast ease-qsh-out dark:text-coral-200"
              onClick={() => setShowWarning(false)}
            >
              这不适合我
            </button>
            <button
              type="button"
              className="rounded-control bg-coral-500 px-4 py-3 font-medium text-white transition-colors duration-qsh-fast ease-qsh-out hover:bg-coral-600"
              onClick={confirmEnable}
              disabled={saveSettings.isPending}
            >
              我了解了，开启计时
            </button>
          </div>
        </section>
      ) : null}

      <section className="qsh-surface p-5">
        <h1 className="text-title font-semibold text-slate-800 dark:text-slate-100">断食计时</h1>

        {/* ⚠️ 三分支，不可退回单一 `!settings`：`retry: 0` 之下请求失败会让 `data` 恒为 `undefined`，
             `!settings` 永真 → 骨架块**永远停不下来**，而「正在读取设置…」是 `sr-only`
             （sighted 用户零可见文字），页面上也没有任何重试入口 —— 用户既不知道出了什么事，
             也只能刷新整页。病根与「读不到 == 没有」同源：拿不到 ≠ 还在路上，更 ≠ 已关闭。 */}
        {settingsQuery.isError ? (
          // 失败专属区块：中性灰底 + 一句软着陆 + 一个重试入口（调 `refetch()`，成功后自动消失）。
          // 形态与 `HabitsPage` 的「读不到」块一致；不用 `StateBlock` 是因为本卡已有外层
          // `.qsh-surface`，套两层卡片会变成「卡中卡」。文案复用全站既有的 `COPY.offlineNotice`。
          <div
            role="status"
            data-testid="fasting-settings-error"
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control bg-slate-100 px-4 py-2 text-body text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          >
            <span>{COPY.offlineNotice}</span>
            <button
              type="button"
              data-testid="fasting-settings-retry"
              className="qsh-touch-target rounded-control px-2 py-1 font-medium text-brand-700 underline underline-offset-2 transition-colors duration-qsh-base ease-qsh-out disabled:opacity-60 dark:text-brand-300"
              disabled={settingsQuery.isFetching}
              onClick={() => {
                void settingsQuery.refetch();
              }}
            >
              重新试试
            </button>
          </div>
        ) : !settings ? (
          // 骨架而非裸文案：给 `min-h-[88px]` 与真实内容块同量级的高度，
          // 设置到位那一刻不再「跳一下」。骨架块用 `rounded-control`，与下方内嵌数据块对齐。
          // `正在读取设置…` 对读屏仍有价值，故保留（`aria-live` 由父容器提供）。
          <div className="mt-2 min-h-[88px]" role="status" aria-live="polite" data-testid="fasting-settings-loading">
            <span className="qsh-sr-only">正在读取设置…</span>
            <div className="h-12 w-full animate-pulse rounded-control bg-slate-100 dark:bg-slate-700" />
            <div className="mt-2 h-8 w-2/3 animate-pulse rounded-control bg-slate-100 dark:bg-slate-700" />
          </div>
        ) : settings.enabled ? (
          <>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              当前方案 <span className="font-bold">{settings.plan}</span>（目标 {settings.targetFastHours} 小时）
            </p>
            {session && !session.endedAt ? (
              <div className="mt-4 rounded-control bg-slate-50 p-3 text-center dark:bg-slate-700">
                <p className="text-xs text-slate-600 dark:text-slate-300">已断食</p>
                <p className="mt-tight text-4xl font-bold text-slate-800 dark:text-slate-100" aria-live="off">
                  {session.elapsedHours.toFixed(1)}
                  <span className="text-base font-normal"> 小时</span>
                </p>
                <p className="mt-tight text-sm text-slate-500 dark:text-slate-300">
                  {session.remainingHours > 0 ? `还有 ${session.remainingHours.toFixed(1)} 小时到目标` : '已经达到目标啦'}
                </p>
                <button
                  type="button"
                  className="mt-4 w-full rounded-control border border-slate-300 px-4 py-3 font-medium text-slate-700 dark:border-slate-500 dark:text-slate-200"
                  onClick={() => stop.mutate()}
                >
                  结束这次断食
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="mt-4 w-full rounded-control bg-slate-700 px-4 py-3 font-medium text-white"
                onClick={() => start.mutate()}
                disabled={start.isPending}
              >
                开始一次断食
              </button>
            )}
            <button
              type="button"
              className="mt-block w-full rounded-control border border-slate-200 px-4 py-2 text-sm text-slate-500 dark:border-slate-600 dark:text-slate-400"
              onClick={() => saveSettings.mutate({ enabled: false })}
            >
              关闭断食功能
            </button>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              计时器默认关闭。如果你想了解，我们会先把风险讲清楚，再由你决定。
            </p>
            <button
              type="button"
              className="mt-4 w-full rounded-control border border-slate-300 px-4 py-3 font-medium text-slate-700 dark:border-slate-500 dark:text-slate-200"
              onClick={requestEnable}
            >
              了解并考虑开启（16:8 / 18:6）
            </button>
          </>
        )}
        {notice ? <p className="mt-block text-sm text-brand-700 dark:text-brand-400">{notice}</p> : null}
        <p className="mt-block text-xs text-slate-600 dark:text-slate-400">我们不会因为断食给你发任何提醒或推送。</p>
        <Link
          to="/why-numbers#why-fasting-title"
          className="mt-block inline-block text-sm font-medium text-brand-700 dark:text-brand-300"
        >
          这些数字是怎么来的 →
        </Link>
      </section>
    </div>
  );
}
