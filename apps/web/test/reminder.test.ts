import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY, reminderMessage } from '@/lib/copy';
import {
  REMINDER_ENABLED_KEY,
  REMINDER_LAST_SENT_KEY,
  disableReminder,
  enableReminder,
  localDateKey,
  maybeSendDailyReminder,
  readReminderEnabled,
} from '@/lib/reminder';

/**
 * 每日轻提醒纯逻辑单测（三期）。
 *
 * 覆盖硬性约束：**默认关闭；用户没开启就绝不发通知**（偏好存 localStorage，
 * 一天最多一条本地 Notification；本轮不做服务端推送）。
 */

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requested: NotificationPermission = 'default';
  static sent: Array<{ title: string; body?: string }> = [];

  constructor(public title: string, public options?: { body?: string }) {
    FakeNotification.sent.push({ title, body: options?.body });
  }

  static async requestPermission(): Promise<NotificationPermission> {
    return FakeNotification.requested;
  }
}

beforeEach(() => {
  window.localStorage.clear();
  FakeNotification.permission = 'default';
  FakeNotification.requested = 'default';
  FakeNotification.sent = [];
  vi.stubGlobal('Notification', FakeNotification as unknown as typeof Notification);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('localDateKey', () => {
  it('本地时区 YYYY-MM-DD（不用 UTC 切片，K5）', () => {
    const date = new Date(2026, 8, 12, 23, 30);
    expect(localDateKey(date)).toBe('2026-09-12');
  });
});

describe('readReminderEnabled / disableReminder', () => {
  it('默认关闭（localStorage 为空 → false）', () => {
    expect(readReminderEnabled()).toBe(false);
  });

  it('disableReminder 清空偏好与当日发送标记', () => {
    window.localStorage.setItem(REMINDER_ENABLED_KEY, 'true');
    window.localStorage.setItem(REMINDER_LAST_SENT_KEY, '2026-09-12');
    disableReminder();
    expect(window.localStorage.getItem(REMINDER_ENABLED_KEY)).toBeNull();
    expect(window.localStorage.getItem(REMINDER_LAST_SENT_KEY)).toBeNull();
  });
});

describe('enableReminder', () => {
  it('用户拒绝授权 → 偏好不写入', async () => {
    FakeNotification.requested = 'denied';
    const result = await enableReminder();
    expect(result).toBe('denied');
    expect(window.localStorage.getItem(REMINDER_ENABLED_KEY)).toBeNull();
  });

  it('用户授权 granted → 偏好写入 true', async () => {
    FakeNotification.requested = 'granted';
    const result = await enableReminder();
    expect(result).toBe('granted');
    expect(readReminderEnabled()).toBe(true);
  });
});

describe('maybeSendDailyReminder（没开启绝不发通知）', () => {
  it('未开启 → 不发任何通知', () => {
    expect(maybeSendDailyReminder()).toBe(false);
    expect(FakeNotification.sent).toHaveLength(0);
  });

  it('已开启且权限 granted → 当天发一条；同一天第二次调用不再发', () => {
    window.localStorage.setItem(REMINDER_ENABLED_KEY, 'true');
    FakeNotification.permission = 'granted';

    expect(maybeSendDailyReminder()).toBe(true);
    expect(FakeNotification.sent).toHaveLength(1);
    expect(FakeNotification.sent[0]!.title).toBe('轻生活小提醒');

    expect(maybeSendDailyReminder()).toBe(false);
    expect(FakeNotification.sent).toHaveLength(1);
  });

  it('已开启但权限未授权 → 不发（三重守卫）', () => {
    window.localStorage.setItem(REMINDER_ENABLED_KEY, 'true');
    FakeNotification.permission = 'default';
    expect(maybeSendDailyReminder()).toBe(false);
    expect(FakeNotification.sent).toHaveLength(0);
  });

  it('隔天再打开应用 → 可以再发一条', () => {
    window.localStorage.setItem(REMINDER_ENABLED_KEY, 'true');
    FakeNotification.permission = 'granted';
    window.localStorage.setItem(REMINDER_LAST_SENT_KEY, '2026-09-11');

    expect(maybeSendDailyReminder(new Date(2026, 8, 12, 8, 0))).toBe(true);
    expect(FakeNotification.sent).toHaveLength(1);
  });
});

describe('文案与通知内容（PRD §7）', () => {
  it('鼓励语非空且不含禁词（失败 / 超标 / 请反思 / 坚持就是胜利）', () => {
    const banned = ['失败', '超标', '请反思', '坚持就是胜利'];
    for (let day = 1; day <= 28; day += 1) {
      const message = reminderMessage(`2026-09-${String(day).padStart(2, '0')}`);
      expect(message.length).toBeGreaterThan(0);
      for (const word of banned) {
        expect(message.includes(word)).toBe(false);
      }
    }
  });

  it('提醒描述文案不含禁词', () => {
    const banned = ['失败', '超标', '请反思', '坚持就是胜利'];
    for (const value of Object.values(COPY)) {
      if (typeof value === 'string') {
        for (const word of banned) {
          expect(value.includes(word)).toBe(false);
        }
      }
    }
  });
});
