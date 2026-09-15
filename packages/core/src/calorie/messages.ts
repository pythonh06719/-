import type { SafetyFlags } from './types';

/**
 * 构建面向用户的安全提示文案（ARCHITECTURE §7 K4 / PRD §7）。
 *
 * **硬性语气规范**：鼓励式、无负罪感；禁止负向 / 指责性表述（如「未达成」类措辞，详见 PRD §7 K4）。
 *
 * - 触发安全下限 →「这已接近安全下限，建议把目标调得更温和一些」
 * - 触发 30% 缺口上限 →「为了更可持续，已帮你把目标调整为更温和的节奏」
 *
 * 两个标志位可同时为 true（如 TC-01），此时两条文案同时出现；都不触发时返回空数组。
 *
 * @param flags 安全下限 / 缺口上限标志
 * @returns 文案数组（顺序：先下限，后上限）
 */
export function buildSafetyMessages(flags: SafetyFlags): string[] {
  const messages: string[] = [];

  if (flags.floorApplied) {
    messages.push('这已接近安全下限，建议把目标调得更温和一些');
  }

  if (flags.isDeficitCapped) {
    messages.push('为了更可持续，已帮你把目标调整为更温和的节奏');
  }

  return messages;
}
