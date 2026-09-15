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
      className="rounded-2xl border border-coral-200 bg-coral-50 px-4 py-3 dark:border-coral-700 dark:bg-coral-900/30"
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
