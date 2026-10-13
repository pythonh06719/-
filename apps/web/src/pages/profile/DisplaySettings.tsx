import type { ReactElement } from 'react';
import { useTheme } from '@/theme/useTheme';
import type { ThemeMode } from '@/theme/tokens';
import { COPY } from '@/lib/copy';

/**
 * 显示设置（pages/profile/DisplaySettings.tsx）—— 深色模式，2026-10-13 从顶栏迁入。
 *
 * ## 为什么迁
 *
 * 顶栏原有三个切换按钮（热量单位 / 体重单位 / 深色）。拆分决策（用户拍板）：
 * **单位两个留顶栏**——看数字时高频、顺手切（食品包装袋印的是千焦，对比时随手就切）；
 * **深色进设置**——「设一次就忘」的偏好，且进设置后配齐「跟随系统」：
 * 顶栏的 `toggle` 一旦离开 `system` 就回不去，而 `useTheme` 的 `setMode` 一直支持三态
 * （服务端只落 manual light/dark，`system` 视为未表态，见 hook 头注释）。
 *
 * ## 为什么用原生 `<select>`
 *
 * 与「基础数据」的性别 / 活动量同款：零新范式、键盘与读屏全免费；
 * 三态选择用分段按钮要自建 `role="radio"` 的箭头键导航，那是重复造轮子。
 */
export default function DisplaySettings(): ReactElement {
  const { mode, setMode } = useTheme();

  return (
    <section aria-label={COPY.displayTitle} className="qsh-surface p-5">
      <h2 className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">{COPY.displayTitle}</h2>
      <p className="mt-tight text-sm text-slate-600 dark:text-slate-300">{COPY.displayDesc}</p>
      <label className="mt-block block text-sm text-slate-600 dark:text-slate-300">
        {COPY.displayThemeLabel}
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as ThemeMode)}
          className="mt-tight w-full rounded-control border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        >
          <option value="system">{COPY.displayThemeSystem}</option>
          <option value="light">{COPY.displayThemeLight}</option>
          <option value="dark">{COPY.displayThemeDark}</option>
        </select>
      </label>
    </section>
  );
}
