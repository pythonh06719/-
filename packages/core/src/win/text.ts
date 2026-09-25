/**
 * 「体重之外的变化」文本清洗（core/win/text.ts）—— R11.4 的**唯一校验点**（Q-8）。
 *
 * **为什么校验住在 core**：前端「提交前拦截 / 空串静默忽略」与服务端「超限 400 不截断」
 * 必须给出**同一个判定结果**，否则会出现「我写的和我存的不一样」（AC-11.4.2 的反面）。
 *
 * **反游戏化红线**：不产生任何「太短了」「再想想」这类劝导信息 —— 校验结果只有
 * `empty` / `tooLong` 两种中性原因，措辞由调用方（copy.ts）给。
 *
 * 本模块零 IO、零依赖，不得 import `@qsh/shared-types`（K12）。
 */

/** 正文长度上限（AC-11.4.2）。按 Unicode 码点计数（中文 1 字 = 1 码点）。 */
export const WIN_TEXT_MAX_LENGTH = 60;

/**
 * 清洗：trim + 折叠空白（**换行折叠为单个空格**，AC-11.4.9）。
 * 空串 / 非字符串输入返回 `''`。
 *
 * 折叠范围：半角 / 全角空格、制表符、换行 —— 全部归一为单个半角空格；
 * 全角空格（U+3000）在 JS 正则 `\s` 中本就被视为空白，无需特判。
 */
export function normalizeWinText(text: string): string {
  if (typeof text !== 'string') {
    return '';
  }
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * 码点计数（`Array.from(text).length`；emoji 等代理对算 1 个）。
 * 非字符串输入返回 0。
 */
export function winTextLength(text: string): number {
  if (typeof text !== 'string') {
    return 0;
  }
  return Array.from(text).length;
}

/** 校验结果：通过时携带清洗后的文本；不通过时给中性原因与当前长度。 */
export type WinTextCheck =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' | 'tooLong'; length: number };

/**
 * 校验 + 清洗一步完成：
 * - 清洗后为空 → `{ ok:false, reason:'empty' }`（前端**静默忽略不提交**；服务端转 400）；
 * - 长度 > `maxLength`（默认 60）→ `{ ok:false, reason:'tooLong', length }`
 *   （**不截断** —— 后端返回 400 且不入库，AC-11.4.2）；
 * - 否则 `{ ok:true, text }`（清洗后的文本，入库用它）。
 *
 * @param text 用户输入原文
 * @param maxLength 长度上限，默认 {@link WIN_TEXT_MAX_LENGTH}
 */
export function checkWinText(text: string, maxLength: number = WIN_TEXT_MAX_LENGTH): WinTextCheck {
  const cleaned = normalizeWinText(text);
  if (cleaned.length === 0) {
    return { ok: false, reason: 'empty', length: 0 };
  }
  const length = winTextLength(cleaned);
  const limit =
    typeof maxLength === 'number' && Number.isFinite(maxLength) && maxLength > 0
      ? Math.floor(maxLength)
      : WIN_TEXT_MAX_LENGTH;
  if (length > limit) {
    return { ok: false, reason: 'tooLong', length };
  }
  return { ok: true, text: cleaned };
}
