/**
 * 「我的常点」档位记忆单测（C2，core/tools/memory.ts）。
 *
 * 钉死六件事：
 * ① 选择键与字段顺序无关、空值字段不参与；
 * ② 计数口径是**天数**：同一天换好几次只算 1 天（与常吃榜同源）；
 * ③ 纯函数：不改入参；非法日期 / 空档位原样返回，绝不抛错；
 * ④ 有上限：日期按 90 天窗口裁、条目按 12 条裁（localStorage 不会被写大）；
 * ⑤ 回读取「天数最多」，tie-break 与常吃榜一致（最近一天 → key），且**陈旧档位会被白名单滤掉**；
 * ⑥ **不参与任何估算**：记不记忆，`estimateTakeout` / `estimateDrink` 的输出逐字不变。
 */

import { describe, expect, it } from 'vitest';

import { estimateDrink, estimateTakeout } from '../src/tools/estimates';
import {
  TOOL_MEMORY_LIMITS,
  emptyToolChoiceMemory,
  pickRememberedChoice,
  recordToolChoice,
  toolChoiceKey,
  type ToolChoiceMemory,
} from '../src/tools/memory';

const KINDS = ['malatang', 'burger', 'salad'];

/** 连续记录若干天的同一组档位，返回最终记忆。 */
function rememberDays(tool: string, values: Record<string, string>, dates: string[]): ToolChoiceMemory {
  let memory = emptyToolChoiceMemory();
  for (const date of dates) {
    memory = recordToolChoice(memory, { tool, values, date });
  }
  return memory;
}

describe('toolChoiceKey（选择键）', () => {
  it('与字段书写顺序无关', () => {
    expect(toolChoiceKey({ kind: 'latte', sugar: 'half' })).toBe(
      toolChoiceKey({ sugar: 'half', kind: 'latte' }),
    );
  });

  it('空值字段不参与（没选糖度 ≠ 选了无糖）', () => {
    expect(toolChoiceKey({ kind: 'latte', sugar: '' })).toBe('kind=latte');
    expect(toolChoiceKey({})).toBe('');
  });
});

describe('recordToolChoice（记一次选择）', () => {
  it('记下档位与当天日期', () => {
    const memory = recordToolChoice(emptyToolChoiceMemory(), {
      tool: 'drink',
      values: { kind: 'latte', sugar: 'half' },
      date: '2026-09-12',
    });
    expect(memory.tools.drink).toHaveLength(1);
    expect(memory.tools.drink?.[0]?.days).toEqual(['2026-09-12']);
    expect(memory.tools.drink?.[0]?.values).toEqual({ kind: 'latte', sugar: 'half' });
  });

  it('同一天重复记只算 1 天（天数口径，与常吃榜同源）', () => {
    const memory = rememberDays('drink', { kind: 'latte' }, [
      '2026-09-12',
      '2026-09-12',
      '2026-09-12',
    ]);
    expect(memory.tools.drink?.[0]?.days).toEqual(['2026-09-12']);
  });

  it('不同日期累加天数，且日期去重后升序', () => {
    const memory = rememberDays('drink', { kind: 'latte' }, [
      '2026-09-12',
      '2026-09-10',
      '2026-09-11',
      '2026-09-10',
    ]);
    expect(memory.tools.drink?.[0]?.days).toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
  });

  it('纯函数：不修改传入的记忆对象', () => {
    const before = emptyToolChoiceMemory();
    const after = recordToolChoice(before, {
      tool: 'takeout',
      values: { kind: 'burger' },
      date: '2026-09-12',
    });
    expect(before.tools).toEqual({});
    expect(after).not.toBe(before);
    expect(Object.keys(after.tools)).toContain('takeout');
  });

  it('非法日期 / 空档位 → 原样返回（不抛错，记忆不能拖垮工具）', () => {
    const memory = emptyToolChoiceMemory();
    expect(recordToolChoice(memory, { tool: 'takeout', values: { kind: 'burger' }, date: '2026/09/12' })).toBe(
      memory,
    );
    expect(recordToolChoice(memory, { tool: 'takeout', values: {}, date: '2026-09-12' })).toBe(memory);
    expect(recordToolChoice(memory, { tool: '', values: { kind: 'burger' }, date: '2026-09-12' })).toBe(
      memory,
    );
  });

  it('超出 90 天窗口的日期会被裁掉', () => {
    const memory = recordToolChoice(emptyToolChoiceMemory(), {
      tool: 'drink',
      values: { kind: 'latte' },
      date: '2026-09-12',
    });
    const stale = recordToolChoice(
      { version: 1, tools: { drink: [{ key: 'kind=latte', values: { kind: 'latte' }, days: ['2025-01-01'] }] } },
      { tool: 'drink', values: { kind: 'latte' }, date: '2026-09-12' },
    );
    expect(stale.tools.drink?.[0]?.days).toEqual(['2026-09-12']);
    expect(memory.tools.drink?.[0]?.days).toEqual(['2026-09-12']);
  });

  it('每个工具最多记 12 条选择（超出按最近用过裁剪）', () => {
    let memory = emptyToolChoiceMemory();
    for (let index = 0; index < 20; index += 1) {
      memory = recordToolChoice(memory, {
        tool: 'takeout',
        values: { kind: `kind_${String(index).padStart(2, '0')}` },
        date: '2026-09-12',
      });
    }
    expect(memory.tools.takeout).toHaveLength(TOOL_MEMORY_LIMITS.choicesPerTool);
    expect(memory.tools.takeout).toHaveLength(12);
  });

  it('单条选择的日期条数不超过上限（不会把 localStorage 写大）', () => {
    const manyDays = Array.from({ length: 200 }, (_unused, index) => {
      const day = new Date(Date.UTC(2026, 0, 1) + index * 86_400_000);
      return day.toISOString().slice(0, 10);
    });
    const memory = rememberDays('drink', { kind: 'latte' }, manyDays);
    expect(memory.tools.drink?.[0]?.days.length).toBeLessThanOrEqual(TOOL_MEMORY_LIMITS.daysPerChoice);
  });
});

describe('pickRememberedChoice（读回默认档位）', () => {
  it('没有记忆 → null（调用方回落默认档位）', () => {
    expect(pickRememberedChoice(emptyToolChoiceMemory(), { tool: 'takeout', allowed: { kind: KINDS } })).toBeNull();
  });

  it('取天数最多的那组档位', () => {
    let memory = rememberDays('takeout', { kind: 'malatang' }, ['2026-09-01', '2026-09-02', '2026-09-03']);
    memory = recordToolChoice(memory, { tool: 'takeout', values: { kind: 'burger' }, date: '2026-09-10' });
    expect(pickRememberedChoice(memory, { tool: 'takeout', allowed: { kind: KINDS } })).toEqual({
      kind: 'malatang',
    });
  });

  it('天数并列时取最近用过的；再并列按 key 升序（结果不跳动）', () => {
    const memory = {
      version: 1 as const,
      tools: {
        takeout: [
          { key: 'kind=burger', values: { kind: 'burger' }, days: ['2026-09-01'] },
          { key: 'kind=malatang', values: { kind: 'malatang' }, days: ['2026-09-09'] },
        ],
      },
    };
    expect(pickRememberedChoice(memory, { tool: 'takeout', allowed: { kind: KINDS } })).toEqual({
      kind: 'malatang',
    });

    const tie = {
      version: 1 as const,
      tools: {
        takeout: [
          { key: 'kind=salad', values: { kind: 'salad' }, days: ['2026-09-09'] },
          { key: 'kind=burger', values: { kind: 'burger' }, days: ['2026-09-09'] },
        ],
      },
    };
    // burger < salad（key 升序）
    expect(pickRememberedChoice(tie, { tool: 'takeout', allowed: { kind: KINDS } })).toEqual({
      kind: 'burger',
    });
  });

  it('陈旧档位（库里已没有的品类 / 改名后的糖度）被白名单滤掉，不会拿去预选', () => {
    const memory = rememberDays('drink', { kind: 'bubble_tea_old', sugar: 'half' }, [
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ]);
    const allowed = { kind: ['milk_tea', 'latte'], sugar: ['half', 'none'] };
    expect(pickRememberedChoice(memory, { tool: 'drink', allowed })).toBeNull();
  });

  it('工具之间互不影响（外卖的记忆不会跑到饮品上）', () => {
    const memory = rememberDays('takeout', { kind: 'burger' }, ['2026-09-01', '2026-09-02']);
    expect(pickRememberedChoice(memory, { tool: 'takeout', allowed: { kind: KINDS } })).toEqual({
      kind: 'burger',
    });
    expect(pickRememberedChoice(memory, { tool: 'drink', allowed: { kind: ['milk_tea'] } })).toBeNull();
  });

  it('非法入参（空工具名 / 结构损坏）→ null，不抛错', () => {
    expect(pickRememberedChoice(emptyToolChoiceMemory(), { tool: '', allowed: {} })).toBeNull();
    const broken = { version: 1, tools: { drink: 'not-an-array' } } as unknown as ToolChoiceMemory;
    expect(pickRememberedChoice(broken, { tool: 'drink', allowed: {} })).toBeNull();
  });
});

describe('记忆不得影响估算输出（C2 硬约束）', () => {
  it('记不记忆，同一品类 / 档位的估算区间逐字不变', () => {
    const before = estimateTakeout('burger');
    let memory = emptyToolChoiceMemory();
    for (const date of ['2026-09-01', '2026-09-02', '2026-09-03']) {
      memory = recordToolChoice(memory, { tool: 'takeout', values: { kind: 'burger' }, date });
    }
    const after = estimateTakeout('burger');
    expect(after).toEqual(before);
    expect(pickRememberedChoice(memory, { tool: 'takeout', allowed: { kind: KINDS } })).toEqual({
      kind: 'burger',
    });

    const drinkBefore = estimateDrink('latte', 360, 'half');
    const drinkMemory = recordToolChoice(emptyToolChoiceMemory(), {
      tool: 'drink',
      values: { kind: 'latte', size: '360', sugar: 'half' },
      date: '2026-09-12',
    });
    expect(estimateDrink('latte', 360, 'half')).toEqual(drinkBefore);
    expect(drinkMemory.tools.drink?.[0]?.values).toEqual({ kind: 'latte', size: '360', sugar: 'half' });
  });
});
