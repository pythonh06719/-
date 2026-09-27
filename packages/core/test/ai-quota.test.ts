/**
 * AI 每日用量口径单测（B6：剩余次数 = 上限 − 已用）。
 *
 * 钉死四件事：
 * ① 上限 50（与后端 `AiService.consumeQuota` 判定同源，不会两处漂移）；
 * ② 未用 → 剩 50；用 1 → 剩 49；用满 50 → 剩 0；
 * ③ **永不返回负数**（脏数据 / 并发回退前的一瞬也不该显示「剩 −3 次」）；
 * ④ 脏输入（NaN / 负数 / 小数 / 字符串）一律归一化，不抛错。
 */

import { describe, expect, it } from 'vitest';

import { AI_DAILY_LIMIT, deriveAiUsage } from '../src/ai/quota';

describe('deriveAiUsage（AI 剩余次数口径，B6）', () => {
  it('每日上限为 50（与后端限额判定同源）', () => {
    expect(AI_DAILY_LIMIT).toBe(50);
  });

  it('一次没用 → 已用 0、剩余 50', () => {
    expect(deriveAiUsage({ used: 0 })).toEqual({ used: 0, limit: 50, remaining: 50 });
  });

  it('用 1 次 → 剩 49；三个数字始终自洽', () => {
    const summary = deriveAiUsage({ used: 1 });
    expect(summary.remaining).toBe(49);
    expect(summary.used + summary.remaining).toBe(summary.limit);
  });

  it('用满 50 次 → 剩 0（第 51 次由后端挡下，此处只负责展示）', () => {
    expect(deriveAiUsage({ used: 50 })).toEqual({ used: 50, limit: 50, remaining: 0 });
  });

  it('超出上限的脏数据（已用 51 / 999）→ 剩余钳到 0，不为负', () => {
    expect(deriveAiUsage({ used: 51 }).remaining).toBe(0);
    expect(deriveAiUsage({ used: 999 }).remaining).toBe(0);
  });

  it('脏输入（负数 / 小数 / NaN / Infinity / 非数字）→ 归一化且不抛错', () => {
    expect(deriveAiUsage({ used: -5 }).used).toBe(0);
    expect(deriveAiUsage({ used: 3.9 }).used).toBe(3);
    expect(deriveAiUsage({ used: Number.NaN }).used).toBe(0);
    expect(deriveAiUsage({ used: Number.POSITIVE_INFINITY }).used).toBe(0);
    expect(deriveAiUsage({ used: '7' as unknown as number }).used).toBe(0);
  });

  it('可传入自定义上限（未来按账号分档不影响算法）', () => {
    expect(deriveAiUsage({ used: 4, limit: 10 })).toEqual({ used: 4, limit: 10, remaining: 6 });
    // 非法上限 → 回落默认 50
    expect(deriveAiUsage({ used: 4, limit: 0 }).limit).toBe(50);
    expect(deriveAiUsage({ used: 4, limit: Number.NaN }).limit).toBe(50);
  });
});
