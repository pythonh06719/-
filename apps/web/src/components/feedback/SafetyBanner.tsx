import type { ReactElement } from 'react';
import type { ValidationWarning } from '@qsh/shared-types';
import { WARNING_CODES } from '@qsh/core';

/**
 * 安全提示条（components/feedback/SafetyBanner.tsx）。
 *
 * 渲染引擎返回的 `CalorieResult.safetyMessages`（直接文案）与 `warnings`（结构化告警）。
 *
 * **按 `code` 去重取一**（ARCHITECTURE §4.5 末尾约定）：
 * 同一条件可能同时出现在两个通道（如触安全下限既生成 `safetyMessages` 文案，
 * 又产出 `W_FLOOR_APPLIED` 告警）。UI 需按 `code` 去重，避免重复展示。
 *
 * 语气：中性、温和 —— 使用柔和暖色（coral），**不使用红色警告样式**（PRD §7）。
 *
 * ## 为什么保留 coral（而不是换成中性灰）
 *
 * coral 在本项目不是禁用色：`tailwind.config.ts` 明确把它留给「接近上下限等中性提醒」。
 * 全站共 3 处「带描边的 coral 块」，语义都是「这件事需要你留意一下」：
 * 本组件（触安全下限）、`OnboardingPage`（健康状况）、`SettingsDataPage`（硬删除）。
 * 三处同色是**有意的语义分组** —— 若本组件独独换成中性灰，反而多出一套「第四种说法」，
 * 且会让另外两处（尤其硬删除）显得更重。故：**coral 保留，只降强度**。
 *
 * ## 降在哪：把粉色从「底」挪走，只留在「边」和「字」
 *
 * 实测（WCAG 相对亮度，页面底色 `#f0f7f4`）：
 * - 改前 `bg-coral-50` 与页面底色对比度 **1.00:1** —— 几乎为零。也就是说**这块底的粉色
 *   一点可见性都没提供**，全靠 `border-coral-200` 一根描边撑着「这是一块独立内容」。
 * - 后果是：描边被迫独自承担全部语义信号，于是它成了全站最刺眼的元素 ——
 *   视觉紧张感来自「底色几乎透明 + 描边独自承重」的组合，而不是 coral 本身有多红。
 * - 改后底色换成项目既有的卡片面 `bg-white`（`App.tsx` / `ErrorBoundary` / `BarcodeScanner`
 *   等处同一写法），描边保持 `coral-200` 不变。**粉色总量减半，描边可见性反而略升**：
 *   描边 vs 底色 1.43:1 → **1.56:1**；标题文字 7.33:1 → **7.99:1**；note 5.23:1 → **5.70:1**。
 *
 * 深色同理，但按 `theme/dark.css`「换表达而非调暗」：底色从暖调 `coral-900/30`
 * 换成项目既有的深色中性面 `slate-800`，描边提一档到 `coral-600`：
 * 描边 vs 底色 2.15:1 → **2.57:1**（边界更清楚），文字 11.03:1 → 9.37:1、
 * 14.01:1 → 11.91:1（仍约为 AA 阈值的两倍）。
 *
 * ## 「还能被看到吗」—— 能，而且比改前更清楚
 *
 * 这块内容的可见性由**文字**承载（7.99:1 / 9.37:1，远超 AA 的 4.5:1），描边只作边界加固。
 * 降低刺眼的做法是**拿走无贡献的底色**（1.00:1）、**留住并微调描边**（1.43→1.56 / 2.15→2.57），
 * 而不是把描边调淡 —— 若换成 `coral-100`（1.13:1）块会「消失」，那才是真的降低可读性。
 * 另需说明：柔和的 coral 描边达不到 WCAG 1.4.11 的 3:1（要达到需用 `coral-500`，
 * 反而变成刺目的警告色，与 PRD §7 冲突）。这是本项目**改前就有**的取舍，未被本轮恶化。
 */

export interface SafetyBannerProps {
  /** 引擎直接渲染的安全文案（`CalorieResult.safetyMessages`） */
  safetyMessages?: readonly string[];
  /** 结构化告警（`CalorieResult.warnings`） */
  warnings?: readonly ValidationWarning[];
  /** 是否触发安全下限（用于把 `W_FLOOR_APPLIED` 视为已被 safetyMessages 覆盖） */
  floorApplied?: boolean;
  /** 是否触发 30% 缺口上限（防御性：若后端返回 `W_DEFICIT_CAPPED` 也去重） */
  isDeficitCapped?: boolean;
  /** 附加说明（可选） */
  note?: string;
}

/** 由布尔标志推导「已被 safetyMessages 覆盖」的告警码集合。 */
export function coveredWarningCodes(flags: {
  floorApplied?: boolean;
  isDeficitCapped?: boolean;
}): Set<string> {
  const covered = new Set<string>();
  if (flags.floorApplied === true) {
    covered.add(WARNING_CODES.FLOOR_APPLIED);
  }
  if (flags.isDeficitCapped === true) {
    // 按 §4.5 约定截断不另设告警码；此处做防御性去重，兼容后端可能的返回
    covered.add('W_DEFICIT_CAPPED');
  }
  return covered;
}

/** 合并两个通道并按 `code` / 文案去重，返回最终展示列表。 */
export function mergeSafetyNotices(
  safetyMessages: readonly string[],
  warnings: readonly ValidationWarning[],
  flags: { floorApplied?: boolean; isDeficitCapped?: boolean },
): string[] {
  const covered = coveredWarningCodes(flags);
  const fromWarnings = warnings
    .filter((warning) => !covered.has(warning.code))
    .map((warning) => warning.message);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const message of [...safetyMessages, ...fromWarnings]) {
    if (message === '' || seen.has(message)) {
      continue;
    }
    seen.add(message);
    merged.push(message);
  }
  return merged;
}

export default function SafetyBanner({
  safetyMessages = [],
  warnings = [],
  floorApplied = false,
  isDeficitCapped = false,
  note,
}: SafetyBannerProps): ReactElement | null {
  const notices = mergeSafetyNotices(safetyMessages, warnings, { floorApplied, isDeficitCapped });

  if (notices.length === 0 && note === undefined) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-card border border-coral-200 bg-white px-4 py-3 dark:border-coral-600 dark:bg-slate-800"
    >
      <p className="text-sm font-medium text-coral-700 dark:text-coral-200">给你的小提醒</p>
      {notices.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {notices.map((message) => (
            <li key={message} className="text-sm leading-relaxed text-coral-700 dark:text-coral-100">
              {message}
            </li>
          ))}
        </ul>
      )}
      {note !== undefined && (
        <p className="mt-2 text-xs leading-relaxed text-coral-600 dark:text-coral-200">{note}</p>
      )}
    </div>
  );
}
