import { useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import type { RestorePreviewResponse, RestoreRecordCounts, RestoreResult } from '@qsh/shared-types';

import { api, noticeFromError } from '@/lib/api';
import { queryClient, queryKeys } from '@/lib/queryClient';
import { readTextFile } from '@/lib/download';

/** 恢复预览的 6 类记录标签；顺序与服务端统计一致。 */
const RECORD_LABELS: ReadonlyArray<{ key: keyof RestoreRecordCounts; label: string }> = [
  { key: 'weights', label: '体重' },
  { key: 'meals', label: '餐次条目' },
  { key: 'exercises', label: '运动' },
  { key: 'habits', label: '习惯打卡' },
  { key: 'water', label: '饮水' },
  { key: 'wins', label: '体重之外的变化' },
];

type RestorePhase = 'idle' | 'previewing' | 'ready' | 'restoring' | 'done';

/**
 * JSON 备份恢复卡。
 *
 * 严格分成“选择并预览”与“明确确认”两步：选择文件只展示统计，绝不写入；确认后才提交
 * 一次性 previewToken。服务端按实体+日期合并，备份出现的日期替换、其余日期保留。
 */
export default function BackupRestoreCard(): ReactElement {
  const [phase, setPhase] = useState<RestorePhase>('idle');
  const [preview, setPreview] = useState<RestorePreviewResponse | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) {
      return;
    }

    setPhase('previewing');
    setPreview(null);
    setResult(null);
    setNotice('正在看看这份备份里有什么…');
    try {
      const content = await readTextFile(file);
      const response = await api.post<RestorePreviewResponse>('/data/restore/preview', { content });
      setPreview(response);
      setPhase('ready');
      setNotice('预览已准备好。确认前不会改动现有记录。');
    } catch (error) {
      setPhase('idle');
      setNotice(noticeFromError(error, '这次没能读出来，请选择轻生活导出的 JSON 文件'));
    }
  };

  const handleRestore = async (): Promise<void> => {
    if (preview === null || phase !== 'ready') {
      return;
    }
    setPhase('restoring');
    setNotice('正在把备份与现有记录合在一起…');
    try {
      const response = await api.post<RestoreResult>('/data/restore', {
        previewToken: preview.previewToken,
      });
      setResult(response);
      setPhase('done');
      setNotice('备份内容已经合并完成，原来其他日期的记录仍然保留。');
      // 恢复会**整体改写**档案、目标、设置与全部记录 —— 本卡上方文案已向用户承诺
      // 「档案、目标和设置会采用备份内容」。若这里不失效，看板 / 体重 / 我的页在
      // 30 秒 `staleTime` 内继续显示恢复**之前**的旧值，承诺与屏幕对不上（要手动刷新才看得到）。
      // 覆盖导出结构里的全部顶层键（profile / goals / weights / meals / exercises /
      // habits / water / wins / settings）—— 设置里的断食开关也一并重取。
      void queryClient.invalidateQueries({ queryKey: queryKeys.profile });
      void queryClient.invalidateQueries({ queryKey: queryKeys.habits });
      void queryClient.invalidateQueries({ queryKey: queryKeys.fastingSettings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.fastingCurrent });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['weights'] });
      void queryClient.invalidateQueries({ queryKey: ['meals'] });
      void queryClient.invalidateQueries({ queryKey: ['exercises'] });
      void queryClient.invalidateQueries({ queryKey: ['water'] });
      void queryClient.invalidateQueries({ queryKey: ['wins'] });
      void queryClient.invalidateQueries({ queryKey: ['report'] });
    } catch (error) {
      setPhase('idle');
      setPreview(null);
      setNotice(noticeFromError(error, '这次没能完成合并，请重新选择备份文件'));
    }
  };

  const dateRangeLabel =
    preview?.dateRange === null || preview?.dateRange === undefined
      ? '没有日期记录'
      : `${preview.dateRange.from} ～ ${preview.dateRange.to}`;

  return (
    <section
      aria-labelledby="restore-backup-title"
      className="qsh-surface p-5"
    >
      <h2 id="restore-backup-title" className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">
        恢复 JSON 备份
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
        先选择由轻生活导出的 JSON 文件。我们会先展示备份里有什么，只有你再次确认后才会写入。
      </p>
      <p className="mt-2 rounded-control bg-brand-50 px-3 py-2 text-xs leading-relaxed text-brand-800 dark:bg-brand-900/40 dark:text-brand-100">
        合并口径：备份里出现的日期，会用备份中的同类记录替换；备份未包含的日期会保留。档案、目标和设置会采用备份内容。
      </p>

      <label className="qsh-touch-target mt-3 block">
        <span className="sr-only">选择 JSON 备份文件</span>
        <input
          type="file"
          accept=".json,application/json"
          disabled={phase === 'previewing' || phase === 'restoring'}
          onChange={(event) => void handleFile(event)}
          className="block w-full rounded-control border border-brand-100 px-3 py-2 text-sm disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        />
      </label>

      {preview !== null && (
        <div data-testid="restore-preview" className="mt-4 rounded-control border border-brand-100 p-3 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">备份里有什么</h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {RECORD_LABELS.map(({ key, label }) => (
              <div key={key} className="flex items-baseline justify-between gap-2">
                <dt className="text-slate-600 dark:text-slate-300">{label}</dt>
                <dd className="qsh-tnum font-medium text-slate-800 dark:text-slate-100">
                  {preview.counts[key]} 条
                </dd>
              </div>
            ))}
            <div className="col-span-2 flex items-baseline justify-between gap-2 border-t border-slate-100 pt-2 dark:border-slate-700">
              <dt className="text-slate-600 dark:text-slate-300">整体日期跨度</dt>
              <dd className="qsh-tnum text-right font-medium text-slate-800 dark:text-slate-100">
                {dateRangeLabel}
              </dd>
            </div>
          </dl>

          {phase === 'ready' && (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void handleRestore()}
                className="qsh-touch-target flex-1 rounded-control bg-brand-600 px-3 py-3 font-medium text-white transition-colors duration-qsh-fast ease-qsh-out hover:bg-brand-700"
              >
                确认合并这份备份
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreview(null);
                  setNotice(null);
                  setPhase('idle');
                }}
                className="qsh-touch-target rounded-control bg-slate-100 px-4 py-3 text-sm text-slate-700 transition-colors duration-qsh-fast ease-qsh-out hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200"
              >
                先不合并
              </button>
            </div>
          )}
        </div>
      )}

      {result !== null && (
        <p data-testid="restore-result" className="mt-3 text-xs text-slate-600 dark:text-slate-300">
          本次共合并 {Object.values(result.restored).reduce((sum, count) => sum + count, 0)} 条记录。
        </p>
      )}
      {notice !== null && (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-brand-700 dark:text-brand-300">
          {notice}
        </p>
      )}
    </section>
  );
}
