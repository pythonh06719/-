/**
 * 每日轻提醒（三期，最小实现）。
 *
 * 硬性约束：
 * - **默认关闭**；用户没开启就绝不发通知（偏好存 localStorage）。
 * - 本轮只做**本地通知**：当天应用打开期间用浏览器 `Notification` 发一条鼓励语。
 *   不做 VAPID / 服务端推送的原因：① 需要新增推送服务与密钥管理，超出本轮范围；
 *   ② 服务端推送天然带有「打断感」，与 PRD「不主动怂恿」的语气原则冲突，
 *   本地「打开应用才提醒」的形态更温和；后续若做服务端推送，需单独评估（R8.3 同口径）。
 */

import { reminderMessage } from './copy';

/** localStorage 偏好键。 */
export const REMINDER_ENABLED_KEY = 'qsh.reminder.enabled';
/** 当日已发送标记键（保证一天最多一条）。 */
export const REMINDER_LAST_SENT_KEY = 'qsh.reminder.lastSentDate';

/** 本地 `YYYY-MM-DD`（与 K5 一致，不用 UTC 切片）。 */
export function localDateKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 读取开关状态（默认关闭）。 */
export function readReminderEnabled(): boolean {
  try {
    return window.localStorage.getItem(REMINDER_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** 浏览器是否支持 Notification。 */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * 开启流程：请求权限 → 授权才写入偏好。
 * 返回最终权限结果（`granted` / `denied` / `unsupported`）。
 */
export async function enableReminder(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!isNotificationSupported()) {
    return 'unsupported';
  }
  const permission =
    Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
  if (permission !== 'granted') {
    return 'denied';
  }
  try {
    window.localStorage.setItem(REMINDER_ENABLED_KEY, 'true');
  } catch {
    // localStorage 不可用时仍然当次会话可用，但不持久化
  }
  return 'granted';
}

/** 关闭流程：清偏好（不清已授权的系统权限，用户可在浏览器设置里撤回）。 */
export function disableReminder(): void {
  try {
    window.localStorage.removeItem(REMINDER_ENABLED_KEY);
    window.localStorage.removeItem(REMINDER_LAST_SENT_KEY);
  } catch {
    // 同上
  }
}

/**
 * 当天应用打开期间尝试发送一条轻提醒。
 *
 * 三重守卫（满足「用户没开启就绝不发通知」）：
 * 1. 偏好开关已开启；
 * 2. `Notification.permission === 'granted'`；
 * 3. 今天还没发过（本地日期守卫，一天最多一条）。
 */
export function maybeSendDailyReminder(now: Date = new Date()): boolean {
  if (!readReminderEnabled() || !isNotificationSupported()) {
    return false;
  }
  if (Notification.permission !== 'granted') {
    return false;
  }
  const todayKey = localDateKey(now);
  try {
    if (window.localStorage.getItem(REMINDER_LAST_SENT_KEY) === todayKey) {
      return false;
    }
    new Notification('轻生活小提醒', { body: reminderMessage(todayKey), tag: 'qsh-daily-reminder' });
    window.localStorage.setItem(REMINDER_LAST_SENT_KEY, todayKey);
    return true;
  } catch {
    return false;
  }
}
