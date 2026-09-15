import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { COPY } from '@/lib/copy';
import {
  disableReminder,
  enableReminder,
  isNotificationSupported,
  maybeSendDailyReminder,
  readReminderEnabled,
} from '@/lib/reminder';

/**
 * 每日轻提醒设置（三期，最小实现）。
 *
 * - **默认关闭**；开启走浏览器 Notification 权限流程，授权才写入偏好；
 * - 当天应用打开期间由本组件触发**一条**本地鼓励语通知（`maybeSendDailyReminder`）；
 * - 偏好仅存 localStorage，不走服务端推送（原因见 `lib/reminder.ts` 顶部注释）。
 */
export default function ReminderSettings(): ReactElement {
  const [enabled, setEnabled] = useState<boolean>(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(readReminderEnabled());
  }, []);

  // 仅当用户已开启时，当天首次打开应用发一条轻提醒（内部有天级去重守卫）
  useEffect(() => {
    if (readReminderEnabled()) {
      maybeSendDailyReminder();
    }
  }, []);

  const handleToggle = async (): Promise<void> => {
    if (enabled) {
      disableReminder();
      setEnabled(false);
      setNotice(null);
      return;
    }
    const result = await enableReminder();
    if (result === 'granted') {
      setEnabled(true);
      setNotice(COPY.reminderGranted);
    } else if (result === 'denied') {
      setEnabled(false);
      setNotice(COPY.reminderDenied);
    } else {
      setEnabled(false);
      setNotice(COPY.reminderUnsupported);
    }
  };

  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-slate-800">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">{COPY.reminderToggleTitle}</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{COPY.reminderToggleDesc}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={COPY.reminderToggleTitle}
          onClick={() => void handleToggle()}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            enabled ? 'bg-teal-500' : 'bg-slate-300 dark:bg-slate-600'
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      {notice !== null && (
        <p role="status" className="mt-3 text-sm text-teal-600 dark:text-teal-300">
          {notice}
        </p>
      )}
    </section>
  );
}
