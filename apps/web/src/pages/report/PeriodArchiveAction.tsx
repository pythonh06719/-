import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type {
  PeriodReport,
  TopFoodItem,
  WeightTrendPoint,
  WeightTrendResponse,
  WeightUnit,
  WinLog,
} from '@qsh/shared-types';
import { api } from '@/lib/api';
import { downloadTextFile } from '@/lib/download';
import {
  buildPeriodArchiveHtml,
  periodArchiveFileName,
  PERIOD_ARCHIVE_SENSITIVE_NOTICE,
} from '@/lib/period-archive';

/** 阶段回顾存档入口需要的页面快照。 */
interface PeriodArchiveActionProps {
  report: PeriodReport;
  topFoods: readonly TopFoodItem[];
  weightUnit: WeightUnit;
  topFoodsLoading: boolean;
}

/** 读取存档折线所需的同期体重点；请求不可用时由生成器用 R11.3 起止值降级。 */
async function fetchWeightPoints(days: number): Promise<WeightTrendPoint[]> {
  try {
    const response = await api.get<Pick<WeightTrendResponse, 'points'>>('/weights/trend', { days });
    return Array.isArray(response.points) ? response.points : [];
  } catch {
    return [];
  }
}

/** 读取非体重变化原文；请求不可用时仍保存其余已经展示的数据。 */
async function fetchWins(days: number): Promise<WinLog[]> {
  try {
    const response = await api.get<WinLog[]>('/wins', { days });
    return Array.isArray(response) ? response : [];
  } catch {
    return [];
  }
}

/**
 * 「保存这一份」动作与敏感数据确认层。
 *
 * 文件由浏览器内存中的页面快照拼成自包含 HTML，再通过 Blob 下载；不创建云端链接，
 * 也不调用任何第三方服务。补充的折线和文字摘录只读取项目现有的一方接口。
 */
export default function PeriodArchiveAction({
  report,
  topFoods,
  weightUnit,
  topFoodsLoading,
}: PeriodArchiveActionProps): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirming) {
      confirmButtonRef.current?.focus();
    }
  }, [confirming]);

  /**
   * Esc 关闭（与另两处弹窗一致）。
   *
   * ⚠️ 保存中（`saving`）不响应，避免打断在途请求 —— 与 `SaveComboDialog` 的 `busy` 守卫同理。
   * 此前本弹层**独缺**这个监听：实测按 Esc 不关，只能点「先不保存」，而另外两处都能关。
   */
  useEffect(() => {
    if (!confirming) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) {
        setConfirming(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirming, saving]);

  const handleSave = async (): Promise<void> => {
    if (saving) {
      return;
    }
    setSaving(true);
    setNotice(null);

    try {
      const [weightPoints, wins] = await Promise.all([
        report.weight === null ? Promise.resolve([]) : fetchWeightPoints(report.days),
        report.winCount > 0 ? fetchWins(report.days) : Promise.resolve([]),
      ]);
      const content = buildPeriodArchiveHtml({
        report,
        topFoods,
        weightPoints,
        wins,
        weightUnit,
      });
      downloadTextFile({
        content,
        mimeType: 'text/html;charset=utf-8',
        fileName: periodArchiveFileName(report),
        withBom: false,
      });
      setConfirming(false);
      setNotice('已经生成本地存档。打开 HTML 后可以直接阅读、打印或另存 PDF。');
    } catch {
      setNotice('这次没有生成好，稍后再试一次就好。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-5 border-t border-brand-100 pt-4 dark:border-slate-700" data-testid="period-archive-action">
      <button
        type="button"
        disabled={topFoodsLoading || saving}
        onClick={() => {
          setNotice(null);
          setConfirming(true);
        }}
        className="qsh-touch-target w-full rounded-control bg-brand-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60 dark:bg-brand-500 dark:hover:bg-brand-400"
      >
        {topFoodsLoading ? '正在准备存档…' : '保存这一份'}
      </button>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        保存为只在本地生成的 HTML，打开后可打印或另存 PDF。
      </p>
      {notice !== null && (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-brand-700 dark:text-brand-300">
          {notice}
        </p>
      )}

      {confirming &&
        createPortal(
          /**
           * 确认层的遮罩 + 容器。
           *
           * ## 为什么必须 `createPortal` 到 `document.body`（390×844 实测根因）
           *
           * `AppShell` 的 `<main>` 带 `animate-fade-in`，keyframes 含 `transform`。
           * 祖先只要 `transform` 计算值不为 `none`（哪怕停在 `translateY(0)`），就是
           * `position: fixed` 后代的**包含块**；它同时造出**层叠上下文**，把弹层的 `z-50`
           * 困在 `<main>` 内，`<main>` 的兄弟 `<header>`（sticky，`z-30`）反压过弹层。
           *
           * 本页实测（`/report`，该路由是 `wide` 宽屏版，但390px 下与其它页同构）：
           * - `<main>` 高 `601` → 弹层被算成 `t=73 h=601`，**844px 视口里底边 674–844
           *   的 170px 完全裸露**，背景内容透出且可点；
           * - 点 (195,60) 命中原页面 `<header>` 而非 `role=dialog` → **点击穿透**。
           *
           * `createPortal` 到 `body` 同时解决包含块与层叠上下文两件事。
           * **这是根因修复，不是视觉微调。**
           *
           * ## 遮罩取值：由单套 `slate-950/45` 改为深浅两套
           *
           * 改动前只有一套 `slate-950/45`，深浅共用。深色底本身已暗，单套在深色下压不出
           * 浮起感。改用与另两处同款口径（浅 `slate-900/50` / 深 `slate-950/65`），
           * 全站三处弹层遮罩一致。压暗百分比为真浏览器实测，非凭感觉。
           */
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="period-archive-confirm-title"
            aria-describedby="period-archive-confirm-description"
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4 dark:bg-slate-950/65"
          >
            <div className="w-full max-w-md rounded-card bg-white p-6 shadow-xl dark:bg-slate-800">
              <h3 id="period-archive-confirm-title" className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                保存前请留意
              </h3>
              <p
                id="period-archive-confirm-description"
                className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300"
              >
                {PERIOD_ARCHIVE_SENSITIVE_NOTICE}
              </p>
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setConfirming(false)}
                  className="qsh-touch-target rounded-control px-4 text-sm font-medium text-slate-600 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-60 dark:text-slate-300 dark:ring-slate-600 dark:hover:bg-slate-700"
                >
                  先不保存
                </button>
                <button
                  ref={confirmButtonRef}
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSave()}
                  className="qsh-touch-target rounded-control bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60 dark:bg-brand-500 dark:hover:bg-brand-400"
                >
                  {saving ? '正在本地生成…' : '保存到设备'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
