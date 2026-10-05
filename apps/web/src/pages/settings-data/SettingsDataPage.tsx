import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  CsvImportResult,
  ExportFileDescriptor,
  ExportJsonPayload,
  OnboardingResponse,
  Paginated,
  WeightLog,
  WeightTrendPoint,
  WeightTrendResponse,
} from '@qsh/shared-types';
import { api } from '@/lib/api';
import { queryClient, queryKeys } from '@/lib/queryClient';
import { DEFAULT_WATER_GOAL_ML } from '@qsh/core';
import { CACHE_KEYS, cacheClearAll, cacheGet } from '@/lib/local-cache';
import { toExportWeightRows } from '@/lib/csv';
import { JSON_MIME, createEmptyExportPayload, parseWeightCsv, serializeExportBundle } from '@/lib/csv';
import { downloadExportBundle, downloadTextFile, readTextFile } from '@/lib/download';
import { clearLastBackupAt, daysSinceLastBackup, readLastBackupAt, saveLastBackupAt } from '@/lib/backup';
import { clearPlateauVisibility } from '@/lib/plateau-visibility';
import { todayKey } from '@/lib/format';
import { COPY, backupHintCopy, lastBackupLabel } from '@/lib/copy';
import { useUnitStore } from '@/lib/units';
import { fetchServerSettings } from '@/lib/settings-sync';
import { readStoredWaterGoalMl } from '@/lib/water-goal';
import { useAuthStore } from '@/lib/auth.store';
import { clearQueuedRequests, enqueueRequest } from '@/pwa/offline-queue';
import { toTrendPoints } from '@/lib/trend';
import BackupRestoreCard from './BackupRestoreCard';
import DataOverviewCard from './DataOverviewCard';

/**
 * 数据管理（`/settings/data`，PRD §9 / R10 / US-18 / US-19 / TC-39 / TC-40 / TC-41）。
 *
 * - **导出**：一键导出 JSON（完整可恢复）+ CSV（UTF-8 **with BOM**、首行表头、日期 `YYYY-MM-DD`）
 * - **恢复**：JSON 备份先展示内容统计，再由用户确认按“同日覆盖、不同日保留”合并
 * - **导入**：CSV 历史体重批量导入，结果提示「导入条数 / 未读取行数」
 * - **删除我的全部数据**：二次确认 + 明确后果说明；调用硬删除接口并清空本地缓存
 *
 * 导出全程在本地生成 Blob，不经任何第三方服务（隐私承诺，TC-46）。
 * ⚠️ 「导出 / 删除」接口未在 T03 固定契约清单内，此处按 PRD R10 设计并做**优雅降级**：
 * 接口不可用时仍导出本地缓存数据、仍清空本地数据（详见任务回传说明）。
 *
 * ⚠️ **GAP-4（「可完整恢复」的真实范围）**：本页 JSON 覆盖
 * 资料 / 目标 / 体重 / 饮食 / 运动 / 习惯 / 饮水 / 小确幸 / **设置（单位、体重单位、深色、断食开关、每日饮水目标）**。
 * 此前设置段被本地状态覆盖，导致「可完整恢复」名不副实；现已改为取服务端权威值（见 `gatherPayload`）。
 * **范围说明（GAP-3 已补齐）**：`waterGoalMl`（每日饮水目标）现**已在**导出内 ——
 * 此前 App 没有设置入口、也不在导出内（值恒为默认），现已于 `/exercise` 喝水区补上编辑入口，
 * 且服务端 `/data/export` 与本页导出骨架均带 `settings.waterGoalMl`、恢复路径一并还原，
 * 「设置可完整恢复」对饮水目标同样成立。
 */

/**
 * 导入结果提示的两行状态。
 *
 * `errors` 的形状直接取共享契约 `CsvImportResult['errors']`（`{ row, reason }[]`）——
 * **两端一致**（服务端 `data.service.ts` 的 `ImportResult.errors` 同一形状），
 * 本地不再手写一份，避免「服务端改了字段名、前端还在按老形状渲染」这类静默漂移。
 *
 * 离线逐行入队那条路里，`errors` 来自 `parseWeightCsv`（core 解析层），
 * 形状也是 `{ row, reason }`，行号为原文件真实行号 —— 与在线分支口径相同。
 */
type ImportState =
  | { imported: number; skipped: number; errors: CsvImportResult['errors'] }
  | null;

export default function SettingsDataPage(): ReactElement {
  const navigate = useNavigate();
  const unit = useUnitStore((state) => state.unit);
  const weightUnit = useUnitStore((state) => state.weightUnit);
  const clearAuth = useAuthStore((state) => state.clear);
  const [exportState, setExportState] = useState<string | null>(null);
  const [importState, setImportState] = useState<ImportState>(null);
  const [confirmStep, setConfirmStep] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [deleteState, setDeleteState] = useState<string | null>(null);
  /** 上次备份时间戳（C6）：初始值从本机 `localStorage` 读取，成功后滚动更新 */
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(() => readLastBackupAt());
  const [backupState, setBackupState] = useState<string | null>(null);

  /**
   * ≥ 30 天未备份的温和提示（R11.6 / AC-11.6.2）。
   *
   * ⚠️ **纯渲染层条件判断**：不注册任何 `setInterval` / Notification / Service Worker 定时触发，
   * 也不做弹窗与横幅（AC-11.6.3 / NFR-10）。
   *
   * ⚠️ 与 `lastBackupLabel` **并存、不合并**：`lastBackupLabel` 是 C6 基座的事实陈述（回归保护），
   * 本行只是它**下面追加**的一句温和提醒；< 30 天时 `backupHintCopy` 返回 `null`，整行不渲染。
   */
  const backupHint = useMemo(() => backupHintCopy(daysSinceLastBackup(lastBackupAt)), [lastBackupAt]);

  /**
   * 汇总导出数据：优先服务端，未成功时回退本地缓存（保证导出按钮在离线时也可用）。
   *
   * ⚠️ **GAP-4 修复**：`settings` 段必须反映**服务端真实值**。
   *
   * 原实现先用本地状态（`useUnitStore.unit` + `<html class="dark">`）重写了 `settings`，
   * 导致「导出 JSON 可完整恢复」的承诺与行为相反 —— 用户切到 kJ / 开了深色后，
   * 若服务端尚未被写回（旧版本）或本地与服务端不一致，导出的仍是 `kcal / false`。
   *
   * **判断（删还是改）**：选择「**改**」而非删 —— 本地回退是有价值的：
   * 离线 / 后端未就绪时仍要能导出（本页头注释的「优雅降级」承诺）。
   * 因此改为：**先拉服务端权威 `settings`，成功则以它为准；失败才回退本地状态**。
   * 这样在线时导出的是服务端真值（可完整恢复），离线时仍可导出（体面降级）。
   */
  const gatherPayload = async (): Promise<ExportJsonPayload> => {
    const payload = createEmptyExportPayload(new Date().toISOString());
    // 本地回退值（仅服务端不可达时使用）：单位取当前 store，深色取 `<html class>`，
    // 饮水目标取本机记住的值（离线时用户仍能导出自己设过的目标，而不是被打回默认）。
    payload.settings = {
      unit,
      weightUnit,
      darkMode:
        typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
      fastingEnabled: false,
      waterGoalMl: readStoredWaterGoalMl() ?? DEFAULT_WATER_GOAL_ML,
    };

    // 设置：优先服务端权威值（GAP-4：导出的 settings 必须反映服务端真值）
    const serverSettings = await fetchServerSettings();
    if (serverSettings !== null) {
      payload.settings = {
        unit: serverSettings.unit,
        weightUnit: serverSettings.weightUnit,
        darkMode: serverSettings.darkMode,
        fastingEnabled: serverSettings.fastingEnabled,
        // GAP-3：饮水目标随导出（此前不在导出内，恢复后会打回默认 —— 与承诺相反）
        waterGoalMl: serverSettings.waterGoalMl,
      };
    }

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
   *
   * ⚠️ 该快照里的 `settings`（单位 / 深色 / 断食开关）之所以「可完整恢复」，前提是
   * 这些设置**确实被写回服务端** —— 这正是 GAP-4 的修复点（见 `lib/units.ts` / `theme/useTheme.ts`）。
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

  /**
   * CSV 历史体重导入（§9.3 / **GAP-6**）。
   *
   * ### 两条路径，各有各的理由（不是「先试再兜底」）
   *
   * - **在线 → 走批量接口** `POST /data/import/weights`（`{ rows }`）：
   *   服务端在**单事务**里批量 upsert，一个请求搞定 N 行。
   *   此前这里是 `for` 循环逐行 POST `/weights` —— 500 行就是 500 次串行往返，
   *   正是这条批量接口（早写好了、注释里写着「为替代逐行往返」）要解决的问题。
   *
   * - **离线 → 逐行入队**（保留原能力）：`navigator.onLine === false` 时逐行走
   *   `enqueueRequest`。**为什么不把整批也塞进队列**：一个「带 500 行」的队列项
   *   在重放时要么全成、要么全败 —— 中间任何一行触发业务错误，整批都没落库；
   *   逐行入队保留了**部分成功的可恢复性**（好的那几笔先送出去，坏的单独重试/丢弃，
   *   与 `flushQueue` 的既有语义一致）。**在线求快、离线求稳**，两条路都是刻意的。
   *
   * ### 字段名对齐
   * 传的是 `parsed.rows`（`{ date, weightKg, note? }`，`@qsh/core` 的解析产物），
   * **不是** `/weights` 单条写入用的 `loggedAt` —— 后端 `WeightImportRow` 要的就是
   * `date` / `weightKg` / `note`。命名差异就在这里一次性抹平，不在中间层做转换。
   */
  const handleImport = async (file: File): Promise<void> => {
    setImportState(null);
    const text = await readTextFile(file);
    const parsed = parseWeightCsv(text);

    // 离线：逐行入队（保留部分成功的可恢复性），不发批量请求。
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      let queued = 0;
      for (const row of parsed.rows) {
        await enqueueRequest({
          path: '/weights',
          method: 'POST',
          body: { loggedAt: row.date, weightKg: row.weightKg, ...(row.note === undefined ? {} : { note: row.note }) },
        });
        queued += 1;
      }
      setImportState({ imported: queued, skipped: parsed.errors.length, errors: parsed.errors });
      return;
    }

    // 在线：一个请求批量导入（单事务由服务端保证）。
    //
    // 类型用共享契约 `CsvImportResult` 而不是本地再造一个（GAP-6 的收口）：
    // 服务端返回的结构是它的**子集**（少一个 `overwritten`），收窄读取是安全的；
    // 用契约类型能让「前后端对同一个响应各写一份类型」的漂移无从发生。
    // `overwritten` 本项目暂不展示（理由见 `data.service.ts` 的 `ImportResult` 注释）。
    const result = await api.post<CsvImportResult>('/data/import/weights', { rows: parsed.rows });
    setImportState({
      imported: result.imported,
      skipped: result.skipped,
      // `errors` 形状两端一致，都是 `{ row, reason }[]`；防御性兜一层，响应异常时按空明细处理。
      errors: Array.isArray(result.errors) ? result.errors : [],
    });

    // 批量导入会**整体改写体重序列** → 体重曲线、看板（当前体重 / 目标进度）、
    // 回看类卡片（`report.*`）都是它的派生视图，必须重取；否则导入 50 条历史体重后
    // 曲线一条不变，用户只能手动刷新页面才看得到。
    void queryClient.invalidateQueries({ queryKey: queryKeys.weightTrend });
    void queryClient.invalidateQueries({ queryKey: ['weights'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['report'] });
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
    // 与登出 / 401（`App.tsx`）同一条纪律：`cacheClearAll()` 清的是 localStorage 那一层，
    // react-query 的内存缓存是**第二层**。一键清数据后内存里若还留着旧档案 / 看板，
    // 用户回到首页会看到「刚删掉」的内容 —— 必须一并清掉。
    queryClient.clear();
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
      <h1 id="data-title" className="text-display font-semibold text-slate-900 dark:text-slate-100">
        数据管理
      </h1>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        你的数据属于你：随时可以带走，也随时可以彻底删除。全程不经过任何第三方服务。
      </p>

      {/* 导出 */}
      <section
        aria-label="导出数据"
        className="qsh-surface p-5 dark:ring-slate-700"
      >
        <h2 className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">导出我的数据</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          JSON 可完整恢复你的资料、目标、记录与设置（单位、体重单位、深色、断食开关、饮水目标）；
          CSV 每实体一个文件，UTF-8 with BOM，首行表头，日期为 YYYY-MM-DD。
        </p>
        <button
          type="button"
          onClick={() => void handleExport()}
          className="qsh-touch-target mt-3 w-full rounded-control bg-brand-600 py-3 font-medium text-white transition-colors duration-qsh-fast ease-qsh-out hover:bg-brand-700"
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
        className="qsh-surface p-5 dark:ring-slate-700"
      >
        <h2 className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">
          {COPY.dataBackupTitle}
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{COPY.dataBackupDesc}</p>
        <button
          type="button"
          onClick={() => void handleBackup()}
          className="qsh-touch-target mt-3 w-full rounded-control bg-brand-600 py-3 font-medium text-white transition-colors duration-qsh-fast ease-qsh-out hover:bg-brand-700"
        >
          {COPY.dataBackupButton}
        </button>
        {/* C6 基座：三态事实陈述（回归保护，AC-11.6.1 —— 只增不删、只加不改） */}
        <p
          data-testid="last-backup"
          className="mt-2 text-xs text-slate-500 dark:text-slate-400"
        >
          {lastBackupLabel(daysSinceLastBackup(lastBackupAt))}
        </p>
        {/* ≥ 30 天未备份的温和提示（新增，与上面一行**并列**而非替换）。
            文字色**刻意**与上一行 `last-backup` 保持一致（`slate-500 / dark:slate-400`）：
            两行是同一段话的上下句，分出两种灰会被读成两个层级；
            该组色在本卡底色上为 4.76:1（浅）/ 5.71:1（深），满足 WCAG AA 正文标准。 */}
        {backupHint !== null && (
          <p
            data-testid="backup-hint"
            className="mt-1.5 text-xs text-slate-500 dark:text-slate-400"
          >
            {backupHint}
          </p>
        )}
        {backupState !== null && (
          <p role="status" aria-live="polite" className="mt-2 text-sm text-brand-700 dark:text-brand-300">
            {backupState}
          </p>
        )}
      </section>

      {/* 记录概览（R11.6 缺口 ②）：只读聚合，`count = 0` 的行由卡内部整行隐藏 */}
      <DataOverviewCard />

      {/* JSON 备份恢复：独立于 CSV 体重导入，先预览、再确认 */}
      <BackupRestoreCard />

      {/* 导入历史体重（CSV） */}
      <section
        aria-label="导入历史体重"
        className="qsh-surface p-5 dark:ring-slate-700"
      >
        <h2 className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">导入历史体重（CSV）</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          模板列：<code>date</code>（YYYY-MM-DD）、<code>weightKg</code>、<code>note</code>（可选）。
          同日期以导入值覆盖，未能识别的行会跳过并汇总。
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
            className="block w-full rounded-control border border-brand-100 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>
        {importState !== null && (
          <div role="status" aria-live="polite" className="mt-3 rounded-control bg-brand-50 px-3 py-2 dark:bg-brand-900/40">
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
        className="rounded-card border border-coral-200 bg-coral-50 p-5 dark:border-coral-700 dark:bg-coral-900/30"
      >
        <h2 className="text-subtitle font-semibold text-coral-700 dark:text-coral-200">删除我的全部数据</h2>
        <p className="mt-1 text-xs leading-relaxed text-coral-700 dark:text-coral-100">
          这是<strong className="font-semibold">硬删除</strong>：账号、体重、饮食、设置等全部记录都会从服务器真实移除，无法恢复。
          建议先「导出我的数据」留一份备份。
        </p>

        {confirmStep === 'idle' && (
          <button
            type="button"
            onClick={() => setConfirmStep('confirm')}
            className="qsh-touch-target mt-3 w-full rounded-control bg-coral-500 py-3 font-medium text-white transition-colors duration-qsh-fast ease-qsh-out hover:bg-coral-600"
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
                className="qsh-touch-target flex-1 rounded-control bg-coral-500 py-3 font-medium text-white transition-colors duration-qsh-fast ease-qsh-out hover:bg-coral-600"
              >
                确认删除
              </button>
              <button
                type="button"
                onClick={() => setConfirmStep('idle')}
                className="qsh-touch-target flex-1 rounded-control bg-white py-3 text-sm text-slate-600 ring-1 ring-brand-100 transition-colors duration-qsh-fast ease-qsh-out hover:bg-brand-50 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
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
