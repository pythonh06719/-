/**
 * 平台期说明卡的「展示频控」本机状态（lib/plateau-visibility.ts，AC-11.1.6）。
 *
 * PRD `docs/PRD.md` AC-11.1.6：**同一天内最多展示一次；用户手动关闭后 7 天内不再自动出现；
 * 关闭状态持久化（存本地即可）**。
 *
 * 设计要点：
 * - 只在本机 `localStorage` 存两个键（最近一次自动展示的**本地日期键** / 手动关闭的 **ISO 时间戳**），
 *   不动 schema、不加服务端字段、不上报；
 * - 天差一律按**本地日粒度**折算（复用 `lib/backup.ts` 同款做法），避免 UTC 截断把「今天」错算成「昨天」；
 * - **频控只压制展示，不改变 `detectWeightPlateau()` 的判定结果** —— core 纯函数照常算，是否渲染由本模块说；
 * - 键名与 `qsh:cache:*` 前缀无关，因此不会被 `cacheClearAll()` 顺带清掉；
 *   账号硬删除时由 `SettingsDataPage` 显式调用 {@link clearPlateauVisibility} 清理（呼应「数据已从本机移除」）。
 */

import { toLocalDateKey } from '@qsh/core';
import { diffDays, todayKey } from './format';

/** 最近一次「自动展示」的本地日期键（`YYYY-MM-DD`）。 */
export const PLATEAU_LAST_SHOWN_KEY = 'plateauLastShownDate';
/** 「手动关闭」的时间戳（ISO 字符串）。 */
export const PLATEAU_DISMISSED_AT_KEY = 'plateauDismissedAt';
/** 手动关闭后压制自动展示的天数窗口（AC-11.1.6：7 天）。 */
export const PLATEAU_DISMISS_DAYS = 7;

/** 本机频控状态快照。 */
export interface PlateauVisibilityState {
  /** 最近一次自动展示的本地日期键；从未展示过为 `null` */
  shownDate: string | null;
  /** 手动关闭的时间戳（ISO）；从未关闭过为 `null` */
  dismissedAt: string | null;
}

function readRaw(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 忽略：隐私模式 / 容量超限不应影响主流程
  }
}

function removeRaw(key: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}

/** 读取最近一次自动展示的本地日期键。 */
export function readPlateauShownDate(): string | null {
  return readRaw(PLATEAU_LAST_SHOWN_KEY);
}

/** 读取手动关闭的时间戳（ISO）。 */
export function readPlateauDismissedAt(): string | null {
  return readRaw(PLATEAU_DISMISSED_AT_KEY);
}

/** 一次性读取两个键（供渲染期做判定）。 */
export function readPlateauVisibilityState(): PlateauVisibilityState {
  return { shownDate: readPlateauShownDate(), dismissedAt: readPlateauDismissedAt() };
}

/** 记录「今天已自动展示过」（幂等：同一天重复调用只写同一个日期键）。 */
export function markPlateauShown(now: Date = new Date()): void {
  writeRaw(PLATEAU_LAST_SHOWN_KEY, todayKey(now));
}

/** 记录「用户手动关闭」（存 ISO 时间戳，天差在读取时按本地日粒度折算）。 */
export function markPlateauDismissed(now: Date = new Date()): void {
  writeRaw(PLATEAU_DISMISSED_AT_KEY, now.toISOString());
}

/** 清除平台期卡的本地频控状态（账号硬删除时一并清理）。 */
export function clearPlateauVisibility(): void {
  removeRaw(PLATEAU_LAST_SHOWN_KEY);
  removeRaw(PLATEAU_DISMISSED_AT_KEY);
}

/**
 * 距手动关闭的天数（**本地日粒度**）；未关闭 / 无法解析 → `null`。
 *
 * @param iso 关闭时间戳（如 `2026-09-12T03:00:00.000Z`），无则 `null`
 * @param now 当前时间（默认 `new Date()`，便于测试注入）
 */
export function daysSincePlateauDismissed(iso: string | null, now: Date = new Date()): number | null {
  if (iso === null) {
    return null;
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return diffDays(toLocalDateKey(parsed), todayKey(now));
}

/**
 * 是否应当**自动展示**平台期卡（纯函数，便于测试）。
 *
 * 两个闸门，任一命中即不展示：
 * 1. **同一自然日内最多一次** —— 今天已经展示过（`shownDate === 今天`）就不再自动出现；
 * 2. **手动关闭后 7 天内不再自动出现** —— `距关闭天数 < {@link PLATEAU_DISMISS_DAYS}`。
 *
 * 注意：本函数只回答「要不要渲染」，**不参与** `detectWeightPlateau()` 的判定；
 * 也**不产生副作用**（写状态由调用方在真正展示 / 关闭时调 `markPlateau*`）。
 *
 * @param state 本地状态快照（见 {@link readPlateauVisibilityState}）
 * @param now 当前时间（默认 `new Date()`，便于测试注入）
 */
export function shouldShowPlateau(
  state: PlateauVisibilityState,
  now: Date = new Date(),
): boolean {
  const today = todayKey(now);
  if (state.shownDate === today) {
    return false;
  }
  const sinceDismissed = daysSincePlateauDismissed(state.dismissedAt, now);
  // 负值（时钟回拨 / 未来时间戳）同样按「刚关闭」处理，宁可少弹也不打扰
  if (sinceDismissed !== null && sinceDismissed < PLATEAU_DISMISS_DAYS) {
    return false;
  }
  return true;
}
