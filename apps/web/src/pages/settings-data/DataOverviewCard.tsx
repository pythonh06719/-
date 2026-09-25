import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { DataOverviewResponse, RecordOverviewRow } from '@qsh/shared-types';
import { api } from '@/lib/api';
import { COPY, OVERVIEW_KEY_LABELS, dataOverviewDetail } from '@/lib/copy';
import { formatMonthDay, todayKey } from '@/lib/format';

/**
 * 记录概览卡（pages/settings-data/DataOverviewCard.tsx，R11.6 / AC-11.6.6）。
 *
 * 只陈述「记了多少条、跨度多久」这一事实，**不做任何异常 / 离群值判定**
 * （AC-11.6.7 硬约束 —— 「异常」本身就是一种评判，会暗示用户的记录错了）。
 *
 * - `count === 0` 的行**整行隐藏**（不显示 0，避免把 0 读成一种成绩）；
 * - `wins` 行本轮恒为 0（R11.4 未做），因此**自动隐藏**；
 *   将来 R11.4 上线只要后端开始返回真实条数，前端无需改动（Q-6）；
 * - 只读一个 `GET /api/data/overview`，不产生任何上传类调用（AC-11.6.9）。
 *
 * ## UI 规范自检（`docs/VISUAL-SYSTEM.md`）
 * - 表面：`.qsh-surface`（elevation-1 + `radius-card` + 焦点环），不再另写 `rounded-*` / `shadow-*`；
 * - 对比度：12px 说明文字用 `slate-600 / dark:slate-300`（§5 的 12px 约束）；
 * - 语义：`<dl>` 左标签（`<dt>`）+ 右事实（`<dd>`），读屏不会读到重复的标签；
 * - 无障碍：本卡**无交互元素**，故无触控目标 / 焦点环 / 动效需求；
 *   加载中与出错一律**整卡不渲染** —— 不拿一张空卡制造压力（无负罪感红线）。
 *
 * ⚠️ **刻意不用 `useQuery`**：本卡挂在 `/settings/data`，而既有的
 * `settings-backup.test.tsx`（C6 回归保护基线）在**没有 `QueryClientProvider`** 的情况下
 * 渲染本页 —— 改用 `api.get` + 局部 state，可以让它不依赖任何外部 Provider，
 * 既不破坏回归基线，也不给页面加一层嵌套的 QueryClient。
 */

/** 日期展示：今天显示为「今天」，其余为「9月12日」。 */
function formatDate(dateKey: string): string {
  return dateKey === todayKey() ? '今天' : formatMonthDay(dateKey);
}

export default function DataOverviewCard(): ReactElement | null {
  const [rows, setRows] = useState<RecordOverviewRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<DataOverviewResponse>('/data/overview')
      .then((response) => {
        if (cancelled) return;
        setRows(response.rows ?? []);
      })
      .catch(() => {
        // 接口不可用 / 离线 → 整卡不渲染（不拿一张空卡制造压力）
        if (!cancelled) {
          setRows(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 只渲染有记录的行。 */
  const visible = useMemo(() => (rows ?? []).filter((row) => row.count > 0), [rows]);

  // 接口未就绪 / 出错 → 整卡不渲染
  if (rows === null) {
    return null;
  }

  return (
    <section
      aria-label={COPY.dataOverviewTitle}
      className="qsh-surface p-5 dark:bg-slate-800 dark:ring-slate-700"
    >
      <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
        {COPY.dataOverviewTitle}
      </h2>
      {visible.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{COPY.dataOverviewEmpty}</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{COPY.dataOverviewDesc}</p>
          <dl className="mt-3 space-y-1.5">
            {visible.map((row) => (
              <div
                key={row.key}
                data-testid={`overview-row-${row.key}`}
                className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-2 last:border-b-0 dark:border-slate-700"
              >
                <dt className="text-sm text-slate-700 dark:text-slate-200">
                  {OVERVIEW_KEY_LABELS[row.key]}
                </dt>
                <dd className="qsh-tnum shrink-0 text-sm text-slate-600 dark:text-slate-300">
                  {dataOverviewDetail(row.count, row.firstDate, row.lastDate, formatDate)}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
