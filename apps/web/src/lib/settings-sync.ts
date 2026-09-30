import type { UserSettings } from '@qsh/shared-types';
import { api } from '@/lib/api';

/**
 * 用户设置同步（lib/settings-sync.ts）—— GAP-4 修复的公共底座。
 *
 * ## 为什么需要这一层
 *
 * 单位（kcal ↔ kJ）与深色模式此前**只写本机 `localStorage`**，从不落库；
 * 而「导出我的数据」的 JSON 备份据「设置可完整恢复」的承诺导出 `settings`。
 * 结果：用户切到 kJ、开了深色 → 导出 JSON 里仍是 `kcal / false` →
 * 按承诺恢复后设置丢失 —— **文案承诺与行为相反**。
 *
 * ## 双层结构：localStorage 快路径 + 服务端权威值
 *
 * - **localStorage（快路径）**：首屏渲染前即可读到，避免主题/单位闪烁（性能路径，必须保留）；
 * - **服务端（权威值）**：跨设备与「恢复备份」后的唯一真源；登录后由 `hydrate*FromServer`
 *   拉取并校准本地。
 *
 * ## 失败处理（负罪感硬约束）
 *
 * 落库失败**绝不打断用户操作**（本地已生效，体验无损），也**不抛红 / 不弹窗**：
 * 仅静默重试一次，仍失败则记 **dirty 标记**，等待联网后补推（见下）。
 *
 * ## P0-2 修复：离线改动不被服务端静默吞掉
 *
 * 缺陷：`SettingsCalibrator` 按 token 去重，同一会话只校准一次；用户离线切 kJ 时
 * `pushSettings` 静默失败，恢复联网后没有补推 —— 下次刷新页面重新校准，
 * **服务端的旧值会覆盖掉用户未推送成功的本地改动**，且用户无从知晓。
 *
 * 修复：**dirty 标记 + 联网重推**，并确立不变量：
 *
 * > **本地的用户改动永远优先于服务端的旧值，直到推送成功为止。**
 *
 * - `pushSettings` 失败 → 写入 dirty 字段集合；
 * - 成功 → 清除对应 dirty 字段；
 * - `hydrate*FromServer` **先** `flushPendingSettings()`（有 dirty 则先推本地值），
 *   **推成功后**才允许用服务端值校准；推不成功（仍离线）则**不校准**，保住本地改动。
 *
 * ### 为什么用 dirty 标记而**不**用离线队列（`pwa/offline-queue.ts`）
 *
 * 设置是**幂等的最后值语义**（`PATCH` 只推当前值）：入队会排队推 5 个中间态
 * （kcal→kj→kcal→…），既无意义又浪费请求。dirty 标记只记「哪些字段待同步」，
 * 联网时推一次**最新值**即可，语义精确、请求最少。故设置类**不入离线队列**。
 */

/** `PATCH /users/settings` 的可更新字段（与后端 `UpdateSettingsDto` 对齐）。 */
export interface SettingsPatch {
  unit?: UserSettings['unit'];
  /** 体重展示单位（D-3，kg / 斤）；存储与导出恒为 kg，仅展示换算。 */
  weightUnit?: UserSettings['weightUnit'];
  darkMode?: boolean;
  fastingEnabled?: boolean;
  waterGoalMl?: number;
}

/** 可被 dirty 追踪的字段集合。 */
type SyncableField = keyof SettingsPatch;

/** dirty 标记的 localStorage 键（跨刷新保留 —— 离线改动后刷新页面正是本修复的场景）。 */
const DIRTY_STORAGE_KEY = 'qsh:settingsDirty';

/** 内存镜像，避免每次读写都碰 localStorage（且便于测试）。 */
let dirtyFields = new Set<SyncableField>();

/** 从 localStorage 载入 dirty 标记（首次访问时惰性初始化）。 */
function loadDirty(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const raw = window.localStorage.getItem(DIRTY_STORAGE_KEY);
    if (raw === null) {
      return;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      dirtyFields = new Set(parsed.filter((item): item is SyncableField => typeof item === 'string'));
    }
  } catch {
    // 坏数据忽略，视为无 dirty
  }
}

/** 把内存镜像写回 localStorage。 */
function saveDirty(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (dirtyFields.size === 0) {
      window.localStorage.removeItem(DIRTY_STORAGE_KEY);
    } else {
      window.localStorage.setItem(DIRTY_STORAGE_KEY, JSON.stringify([...dirtyFields]));
    }
  } catch {
    // 忽略：写不进也仅影响跨刷新补推，不阻断主流程
  }
}

/** 标记字段为「待同步」。 */
function markDirty(fields: SyncableField[]): void {
  loadDirty();
  for (const field of fields) {
    dirtyFields.add(field);
  }
  saveDirty();
}

/** 清除字段的「待同步」标记（推送成功后调用）。 */
function clearDirty(fields: SyncableField[]): void {
  loadDirty();
  for (const field of fields) {
    dirtyFields.delete(field);
  }
  saveDirty();
}

/** 是否有任何待同步字段。 */
export function hasPendingSettings(): boolean {
  loadDirty();
  return dirtyFields.size > 0;
}

/** 测试专用：清空 dirty 标记（内存 + localStorage）。 */
export function __resetDirtyForTest(): void {
  dirtyFields = new Set();
  saveDirty();
}

/**
 * 清空待同步标记（登出调用）。
 *
 * 为什么登出要清：dirty 代表「**某个账号**改了设置但没推成功」。若不清，
 * 换账号后下一次校准会把这个残留值当成「新账号的待同步本地值」补推到新账号 ——
 * 这是比「本地偏好残留」更隐蔽的跨账号污染（会把 A 的偏好写进 B 的服务端设置）。
 * 与 `clearPreferenceKeys()` 配套：一个清本地值，一个清待同步意图。
 */
export function clearPendingSettings(): void {
  dirtyFields = new Set();
  saveDirty();
}

/**
 * 把设置变更同步到服务端（`PATCH /users/settings`），**fire-and-forget**。
 *
 * - 调用方**不需要** `await`，也不会因失败而中断本地操作；
 * - 失败静默重试一次（瞬时网络抖动）；
 * - **二次仍失败 → 记 dirty 标记**（P0-2），联网后由 `flushPendingSettings()` 补推最新值。
 *
 * @param patch 要更新的字段（至少一项）
 * @returns 一个永不 reject 的 Promise（供测试 `await` 观察，正式代码可忽略）
 */
export async function pushSettings(patch: SettingsPatch): Promise<void> {
  const fields = Object.keys(patch) as SyncableField[];
  try {
    await api.patch<UserSettings>('/users/settings', patch);
    clearDirty(fields);
  } catch {
    // 第一次失败（网络抖动 / 偶发 5xx）：静默重试一次
    try {
      await api.patch<UserSettings>('/users/settings', patch);
      clearDirty(fields);
    } catch {
      // 二次仍失败：**记 dirty**，联网后补推。刻意不提示、不抛错 —— 不增加用户负担。
      markDirty(fields);
    }
  }
}

/**
 * 补推所有待同步设置（联网 / 校准前调用）。
 *
 * 读取**当前本地值**作为要推送的内容（最后值语义）—— 由调用方传入，
 * 因为本模块不持有 store，避免反向依赖。
 *
 * @param current 当前本地设置快照（unit / darkMode 至少其一）
 * @returns `true` 表示「已无待同步项」（可以安全用服务端值校准）；
 *          `false` 表示仍有 dirty 且本轮未推成功（调用方**不得**用服务端值覆盖本地）
 */
export async function flushPendingSettings(current: SettingsPatch): Promise<boolean> {
  loadDirty();
  if (dirtyFields.size === 0) {
    return true;
  }
  // 只推 dirty 涉及的字段（其余字段保持服务端原值，不误覆盖）
  const patch: SettingsPatch = {};
  if (dirtyFields.has('unit') && current.unit !== undefined) {
    patch.unit = current.unit;
  }
  if (dirtyFields.has('weightUnit') && current.weightUnit !== undefined) {
    patch.weightUnit = current.weightUnit;
  }
  if (dirtyFields.has('darkMode') && current.darkMode !== undefined) {
    patch.darkMode = current.darkMode;
  }
  if (dirtyFields.has('fastingEnabled') && current.fastingEnabled !== undefined) {
    patch.fastingEnabled = current.fastingEnabled;
  }
  if (dirtyFields.has('waterGoalMl') && current.waterGoalMl !== undefined) {
    patch.waterGoalMl = current.waterGoalMl;
  }
  if (Object.keys(patch).length === 0) {
    // 没有可推的实际值（例如 store 未就绪）：保守起见视为「仍有待同步」
    return false;
  }
  try {
    await api.patch<UserSettings>('/users/settings', patch);
    clearDirty(Object.keys(patch) as SyncableField[]);
    return !hasPendingSettings();
  } catch {
    // 仍不可达：保持 dirty，本地改动不被覆盖
    return false;
  }
}

/**
 * 监听 `online` 事件，联网时补推待同步设置。
 *
 * 幂等：重复注册无副作用（返回取消函数）。由 `SettingsCalibrator` 挂载。
 *
 * @param getCurrent 读取当前本地设置的函数（由调用方注入，避免反向依赖 store）
 * @returns 取消监听的函数
 */
export function registerSettingsOnlineFlush(getCurrent: () => SettingsPatch): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => undefined;
  }
  const onOnline = (): void => {
    void flushPendingSettings(getCurrent());
  };
  window.addEventListener('online', onOnline);
  return () => window.removeEventListener('online', onOnline);
}

/**
 * 登录后 / 启动时从服务端拉取权威设置。
 *
 * ⚠️ **时序**：本函数**不得阻塞首屏**。本机 `localStorage` 的读取发生在首屏之前
 * （避免闪烁），服务端校准在其后异步进行（见 `main.tsx` / 登录成功回调）。
 * 服务端暂不可达时返回 `null`，本地保持原值，不抛错、不白屏。
 *
 * @returns 服务端设置（成功）；不可达 / 未登录时 `null`
 */
export async function fetchServerSettings(): Promise<UserSettings | null> {
  try {
    return await api.get<UserSettings>('/users/settings');
  } catch {
    return null;
  }
}
