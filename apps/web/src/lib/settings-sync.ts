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
 * - **服务端（权威值）**：跨设备与「恢复备份」后的唯一真源；登录后由 `hydrateSettingsFromServer`
 *   拉取并校准本地。
 *
 * ## 失败处理（负罪感硬约束）
 *
 * 落库失败**绝不打断用户操作**（本地已生效，体验无损），也**不抛红 / 不弹窗**：
 * 仅静默重试一次，仍失败则彻底静默 —— 设置同步是后台一致性工作，不是用户可见任务。
 */

/** `PATCH /users/settings` 的可更新字段（与后端 `UpdateSettingsDto` 对齐）。 */
export interface SettingsPatch {
  unit?: UserSettings['unit'];
  darkMode?: boolean;
  fastingEnabled?: boolean;
  waterGoalMl?: number;
}

/**
 * 把设置变更同步到服务端（`PATCH /users/settings`），**fire-and-forget**。
 *
 * - 调用方**不需要** `await`，也不会因失败而中断本地操作；
 * - 失败静默重试一次（瞬时网络抖动），二次仍失败则放弃 —— 不弹任何错误。
 *
 * @param patch 要更新的字段（至少一项）
 * @returns 一个永不 reject 的 Promise（供测试 `await` 观察，正式代码可忽略）
 */
export async function pushSettings(patch: SettingsPatch): Promise<void> {
  try {
    await api.patch<UserSettings>('/users/settings', patch);
  } catch {
    // 第一次失败（网络抖动 / 偶发 5xx）：静默重试一次
    try {
      await api.patch<UserSettings>('/users/settings', patch);
    } catch {
      // 二次仍失败：彻底静默。本地值已生效，服务端值会在下次校准/导出时自愈。
      // 刻意不提示、不抛错 —— 设置同步失败不应给用户增加任何负担。
    }
  }
}

/**
 * 登录后 / 启动时从服务端拉取权威设置，并用它校准本地。
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
