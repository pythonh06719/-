/**
 * 备份时间戳的本机记录（lib/backup.ts，C6）。
 *
 * 只在本机 `localStorage` 存**一个** ISO 时间戳（键固定为 `lastBackupAt`），
 * 用来在设置页展示「上次备份于 X 天前」——
 * 不涉及任何账号数据、不上报、不参与缓存清理策略（与 `qsh:cache:*` 前缀无关）。
 */

import { toLocalDateKey } from '@qsh/core';
import { diffDays, todayKey } from './format';

/** `localStorage` 键（C6 需求固定为 `lastBackupAt`）。 */
export const LAST_BACKUP_KEY = 'lastBackupAt';

/** 记录一次成功备份的时间戳（静默：隐私模式 / 容量超限不影响主流程）。 */
export function saveLastBackupAt(iso: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(LAST_BACKUP_KEY, iso);
  } catch {
    // 忽略
  }
}

/** 读取上次备份的时间戳（不存在 / 不可用返回 `null`）。 */
export function readLastBackupAt(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage.getItem(LAST_BACKUP_KEY);
  } catch {
    return null;
  }
}

/** 清除本机备份时间戳（账号硬删除时一并清理，呼应「数据已从本机移除」）。 */
export function clearLastBackupAt(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.removeItem(LAST_BACKUP_KEY);
  } catch {
    // 忽略
  }
}

/**
 * 距上次备份的天数（**本地日粒度**；时间戳缺失 / 无法解析 → `null`）。
 *
 * 把 ISO 时间戳按**本地时区**折算成日期键再算日历差 ——
 * 直接截取 ISO 的 UTC 日期部分会在时区偏移下把「今天备份」误判成「昨天」。
 *
 * @param iso 上次备份的 ISO 时间戳（如 `2026-09-12T03:00:00.000Z`），无则 `null`
 * @param now 当前时间（默认 `new Date()`，便于测试注入）
 * @returns 天数（≥ 0）；无法判断时 `null`
 */
export function daysSinceLastBackup(iso: string | null, now: Date = new Date()): number | null {
  if (iso === null) {
    return null;
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return diffDays(toLocalDateKey(parsed), todayKey(now));
}
