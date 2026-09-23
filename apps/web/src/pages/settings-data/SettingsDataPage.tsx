import { useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  ExportFileDescriptor,
  ExportJsonPayload,
  OnboardingResponse,
  Paginated,
  WeightLog,
  WeightTrendPoint,
  WeightTrendResponse,
} from '@qsh/shared-types';
import { api } from '@/lib/api';
import { CACHE_KEYS, cacheClearAll, cacheGet } from '@/lib/local-cache';
import { toExportWeightRows } from '@/lib/csv';
import { JSON_MIME, createEmptyExportPayload, parseWeightCsv, serializeExportBundle } from '@/lib/csv';
import { downloadExportBundle, downloadTextFile, readTextFile } from '@/lib/download';
import { clearLastBackupAt, daysSinceLastBackup, readLastBackupAt, saveLastBackupAt } from '@/lib/backup';
import { clearPlateauVisibility } from '@/lib/plateau-visibility';
import { todayKey } from '@/lib/format';
import { COPY, lastBackupLabel } from '@/lib/copy';
import { useUnitStore } from '@/lib/units';
import { useAuthStore } from '@/lib/auth.store';
import { clearQueuedRequests, enqueueRequest } from '@/pwa/offline-queue';
import { toTrendPoints } from '@/lib/trend';

/**
 * 数据管理（`/settings/data`，PRD §9 / R10 / US-18 / US-19 / TC-39 / TC-40 / TC-41）。
 *
 * - **导出**：一键导出 JSON（完整可恢复）+ CSV（UTF-8 **with BOM**、首行表头、日期 `YYYY-MM-DD`）
 * - **导入**：CSV 历史体重批量导入，结果提示「导入条数 / 非法行数」
 * - **删除我的全部数据**：二次确认 + 明确后果说明；调用硬删除接口并清空本地缓存
 *
 * 导出全程在本地生成 Blob，不经任何第三方服务（隐私承诺，TC-46）。
 * ⚠️ 「导出 / 删除」接口未在 T03 固定契约清单内，此处按 PRD R10 设计并做**优雅降级**：
 * 接口不可用时仍导出本地缓存数据、仍清空本地数据（详见任务回传说明）。
 */

type ImportState = { imported: number; skipped: number; errors: { row: number; reason: string }[] } | null;

export default function SettingsDataPage(): ReactElement {
  const navigate = useNavigate();
  const unit = useUnitStore((state) => state.unit);
  const clearAuth = useAuthStore((state) => state.clear);
  const [exportState, setExportState] = useState<string | null>(null);
  const [importState, setImportState] = useState<ImportState>(null);
  const [confirmStep, setConfirmStep] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [deleteState, setDeleteState] = useState<string | null>(null);
  /** 上次备份时间戳（C6）：初始值从本机 `localStorage` 读取，成功后滚动更新 */
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(() => readLastBackupAt());
  const [backupState, setBackupState] = useState<string | null>(null);

  /** 汇总导出数据：优先服务端，未成功时回退本地缓存（保证导出按钮在离线时也可用）。 */
  const gatherPayload = async (): Promise<ExportJsonPayload> => {
    const payload = createEmptyExportPayload(new Date().toISOString());
    payload.settings = {
      unit,
      darkMode:
        typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
      fastingEnabled: false,
    };

    // 体重：优先服务端
    const cachedPoints = cacheGet<WeightTrendPoint[]>(CACHE_KEYS.weightPoints) ?? [];
    payload.weights = toExportWeightRows(cachedPoints);
    try {
      const response = await api.get<WeightTrendResponse | Paginated<WeightLog>>('/weights', {
        limit: 500,
      });
      const items = Array.isArray(response)
        ? response
        : 'points' in response
          ? response.points
          : (response.items ?? []);
      payload.weights = toExportWeightRows(
        toTrendPoints(items as ReadonlyArray<{ weightKg: number; date?: string; loggedAt?: string }>),
      );
    } catch {
      // 离线：使用本地缓存
    }

    // 资料与目标：优先服务端
    try {
      const profile = await api.get<OnboardingResponse>('/profile');
      payload.profile = {
        gender: profile.profile.gender,
        birthDate: profile.profile.birthDate,
        heightCm: profile.profile.heightCm,
        activityLevel: profile.profile.activityLevel,
        dietaryPreference: profile.profile.dietaryPreference,
        conditions: profile.profile.conditions,
      };
      payload.goals = {
        targetWeightKg: profile.goal.targetWeightKg,
        targetWeeks: profile.goal.targetWeeks,
        macroRatio: profile.goal.macroRatio,
      };
    } catch {
      // 离线：保留默认片段
    }

    return payload;
  };

  const handleExport = async (): Promise<void> => {
    setExportState('正在整理你的数据…');
    const payload = await gatherPayload();
    const bundle = serializeExportBundle(payload);
    await downloadExportBundle(bundle);
    const fileCount = bundle.files.length;
    setExportState(
      `已导出 ${fileCount} 个文件：JSON 1 个 + CSV ${fileCount - 1} 个（含体重 ${
        payload.weights.length
      } 条）。CSV 为 UTF-8 with BOM，Excel 打开不乱码。`,
    );
  };

  /**
   * 生成完整备份（C6）：调用服务端 `/data/export` 取**权威**快照（含体重/饮食/套餐等），
   * 落盘为单个 JSON 文件，并把本次时间戳记到本机（`localStorage.lastBackupAt`）。
   *
   * 与上方「一键导出 JSON + CSV」的区别：这里下载的是**服务端权威快照**（一个文件、可完整恢复），
   * 不做离线兜底 —— 拿不到服务端数据时如实告知「这次没成功」，而不是用本地缓存伪装成备份。
   */
  const handleBackup = async (): Promise<void> => {
    setBackupState(COPY.dataBackupRunning);
    try {
      const payload = await api.get<ExportJsonPayload>('/data/export');
      const file: ExportFileDescriptor = {
        fileName: `qingshenghuo-backup-${todayKey()}.json`,
        mimeType: JSON_MIME,
        content: `${JSON.stringify(payload, null, 2)}\n`,
        withBom: false,
      };
      downloadTextFile(file);
      const nowIso = new Date().toISOString();
      saveLastBackupAt(nowIso);
      setLastBackupAt(nowIso);
      setBackupState(COPY.dataBackupDone);
    } catch {
      // 后端未就绪 / 离线：如实说明没成功，不假装已备份（也不引导用户「赶紧」重试）
      setBackupState(COPY.dataBackupFailed);
    }
  };

  const handleImport = async (file: File): Promise<void> => {
    setImportState(null);
    const text = await readTextFile(file);
    const parsed = parseWeightCsv(text);
    let imported = 0;
    for (const row of parsed.rows) {
      try {
        await api.post<WeightLog>('/weights', { loggedAt: row.date, weightKg: row.weightKg, ...(row.note === undefined ? {} : { note: row.note }) });
        imported += 1;
      } catch {
        await enqueueRequest({
          path: '/weights',
          method: 'POST',
          body: { loggedAt: row.date, weightKg: row.weightKg, ...(row.note === undefined ? {} : { note: row.note }) },
        });
        imported += 1;
      }
    }
    setImportState({ imported, skipped: parsed.errors.length, errors: parsed.errors });
  };

  const handleDelete = async (): Promise<void> => {
    setConfirmStep('deleting');
    try {
      await api.delete<{ deleted: boolean }>('/data');
    } catch {
      // 接口不可用也继续完成本地清理（数据主权：用户随时可一键清除）
    }
    await clearQueuedRequests();
    cacheClearAll();
    clearLastBackupAt();
    // AC-11.1.6：平台期卡的本地频控状态也一并清掉（与备份时间戳同理，属「本机记录」）
    clearPlateauVisibility();
    clearAuth();
    setDeleteState('你的数据已经从本机移除。感谢这段日子的使用。');
    setConfirmStep('idle');
    navigate('/');
  };

  return (
    <section aria-labelledby="data-title" className="space-y-5">
      <h1 id="data-title" className="text-xl font-semibold text-slate-900 dark:text-slate-100">
        数据管理
      </h1>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        你的数据属于你：随时可以带走，也随时可以彻底删除。全程不经过任何第三方服务。
      </p>

      {/* 导出 */}
      <section
        aria-label="导出数据"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">导出我的数据</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          JSON 可完整恢复；CSV 每实体一个文件，UTF-8 with BOM，首行表头，日期为 YYYY-MM-DD。
        </p>
        <button
          type="button"
          onClick={() => void handleExport()}
          className="qsh-touch-target mt-3 w-full rounded-xl bg-brand-600 py-3 font-medium text-white transition hover:bg-brand-700"
        >
          一键导出 JSON + CSV
        </button>
        {exportState !== null && (
          <p role="status" aria-live="polite" className="mt-3 text-sm text-brand-700 dark:text-brand-300">
            {exportState}
          </p>
        )}
      </section>

      {/* 备份（C6）：服务端权威快照 → 单个 JSON 文件 */}
      <section
        aria-label="导出备份"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
          {COPY.dataBackupTitle}
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{COPY.dataBackupDesc}</p>
        <button
          type="button"
          onClick={() => void handleBackup()}
          className="qsh-touch-target mt-3 w-full rounded-xl bg-brand-600 py-3 font-medium text-white transition hover:bg-brand-700"
        >
          {COPY.dataBackupButton}
        </button>
        <p
          data-testid="last-backup"
          className="mt-2 text-xs text-slate-500 dark:text-slate-400"
        >
          {lastBackupLabel(daysSinceLastBackup(lastBackupAt))}
        </p>
        {backupState !== null && (
          <p role="status" aria-live="polite" className="mt-2 text-sm text-brand-700 dark:text-brand-300">
            {backupState}
          </p>
        )}
      </section>

      {/* 导入 */}
      <section
        aria-label="导入历史体重"
        className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
      >
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">导入历史体重（CSV）</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          模板列：<code>date</code>（YYYY-MM-DD）、<code>weightKg</code>、<code>note</code>（可选）。
          同日期以导入值覆盖，非法行会跳过并汇总。
        </p>
        <label className="qsh-touch-target mt-3 block">
          <span className="sr-only">选择 CSV 文件</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) {
                void handleImport(file);
              }
              event.target.value = '';
            }}
            className="block w-full rounded-xl border border-brand-100 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>
        {importState !== null && (
          <div role="status" aria-live="polite" className="mt-3 rounded-xl bg-brand-50 px-3 py-2 dark:bg-brand-900/40">
            <p className="text-sm text-brand-700 dark:text-brand-200">
              导入完成：成功 {importState.imported} 条，跳过 {importState.skipped} 行。
            </p>
            {importState.errors.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-600 dark:text-slate-400">
                {importState.errors.slice(0, 5).map((error) => (
                  <li key={`${error.row}-${error.reason}`}>
                    第 {error.row} 行：{error.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* 删除 */}
      <section
        aria-label="删除我的全部数据"
        className="rounded-2xl border border-coral-200 bg-coral-50 p-5 dark:border-coral-700 dark:bg-coral-900/30"
      >
        <h2 className="text-sm font-semibold text-coral-700 dark:text-coral-200">删除我的全部数据</h2>
        <p className="mt-1 text-xs leading-relaxed text-coral-700 dark:text-coral-100">
          这是**硬删除**：账号、体重、饮食、设置等全部记录都会从服务器真实移除，无法恢复。
          建议先「导出我的数据」留一份备份。
        </p>

        {confirmStep === 'idle' && (
          <button
            type="button"
            onClick={() => setConfirmStep('confirm')}
            className="qsh-touch-target mt-3 w-full rounded-xl bg-coral-500 py-3 font-medium text-white transition hover:bg-coral-600"
          >
            删除我的全部数据
          </button>
        )}

        {confirmStep === 'confirm' && (
          <div className="mt-3 space-y-2">
            <p className="text-sm font-medium text-coral-700 dark:text-coral-100">
              再确认一次：删除后无法恢复，确定继续吗？
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleDelete()}
                className="qsh-touch-target flex-1 rounded-xl bg-coral-500 py-3 font-medium text-white"
              >
                确认删除
              </button>
              <button
                type="button"
                onClick={() => setConfirmStep('idle')}
                className="qsh-touch-target flex-1 rounded-xl bg-white py-3 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                我再想想
              </button>
            </div>
          </div>
        )}

        {confirmStep === 'deleting' && (
          <p role="status" aria-live="polite" className="mt-3 text-sm text-coral-700 dark:text-coral-100">
            正在删除…
          </p>
        )}

        {deleteState !== null && (
          <p role="status" aria-live="polite" className="mt-3 text-sm text-slate-600 dark:text-slate-300">
            {deleteState}
          </p>
        )}
      </section>
    </section>
  );
}
