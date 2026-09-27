/**
 * AI 每日用量口径（core/ai/quota.ts）—— B6「AI 页面显示剩余次数」。
 *
 * **唯一真源**：每日上限 `AI_DAILY_LIMIT` 与「剩余 = 上限 − 已用」的算法都放在 core，
 * 前端展示与后端判定（`@qsh/api` 的 `AiService.consumeQuota`）引用同一份，避免两处漂移。
 *
 * 计数口径：**已用 = `ai_usage` 表当日（`usage_date = 今天`）各功能行 `request_count` 的合计**
 * （existing `AiService.consumeQuota` 已经在按这个口径累加，本模块只做展示侧的换算）。
 *
 * 本模块零 IO、零依赖（K12），且**永不返回负数** —— 「剩 −3 次」既没有意义也会制造压力。
 */

/** 每账号每日全部 AI 端点合计限额（R9.4 / TC-45）。 */
export const AI_DAILY_LIMIT = 50;

/** `deriveAiUsage` 的输入。 */
export interface AiUsageInput {
  /** 当日已用次数（`ai_usage.request_count` 合计） */
  used: number;
  /** 覆盖默认上限（一般不需要传；保留给未来按账号分档） */
  limit?: number;
}

/** 用量换算结果（三个数字永远自洽：`used + remaining = limit`，且 `remaining >= 0`）。 */
export interface AiUsageSummary {
  /** 当日已用次数（脏数据已归一：NaN / 负数 / 小数 → 非负整数） */
  used: number;
  /** 当日上限 */
  limit: number;
  /** 剩余次数（下限 0） */
  remaining: number;
}

/** 把任意输入折成非负整数（脏数据不应让页面崩，也不应显示 NaN）。 */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * 由「当日已用」换算「剩余次数」。
 *
 * 算法（与 WhyNumbersPage ⑰ 展示给用户的口径逐字一致）：
 * `remaining = max(0, limit − used)`。
 *
 * 超出的脏数据（如历史数据被手工改大、或并发回退前的一瞬）一律钳到 0，
 * 保证前端永远显示一个有意义、非负的数字。
 */
export function deriveAiUsage(input: AiUsageInput): AiUsageSummary {
  const limitRaw = input.limit;
  const limit =
    typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : AI_DAILY_LIMIT;
  const used = toCount(input.used);

  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
  };
}
