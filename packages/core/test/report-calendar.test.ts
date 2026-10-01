/**
 * 记录足迹日历 · 深浅口径单测（core/report/calendar.ts，C-1 / QC-2 / NFR-11 ㉓）。
 *
 * 钉死的口径：
 * - `0` 类（无记录）→ `0`（留白，不是「第 0 档颜色」）；
 * - `1` 类 = 浅（第 1 档）；`2` 类 = 深（第 2 档，PRD 举例「饮食 + 体重」）；
 * - `≥3` 类封顶在第 3 档（记更多类不再加深）—— 保证前端只有 3 种色阶。
 *
 * 与 `/why-numbers` ㉓ 引用同一个 {@link CALENDAR_DEPTH_MAX_LEVEL}，任何一侧不得自行分档。
 */

import { describe, expect, it } from 'vitest';

import { CALENDAR_DEPTH_MAX_LEVEL, calendarDepthLevel } from '../src/index';

describe('记录足迹日历 · 深浅口径（C-1 / QC-2）', () => {
  it('0 类（无记录）→ 0：留白，不是第 0 档颜色', () => {
    expect(calendarDepthLevel(0)).toBe(0);
    expect(calendarDepthLevel(-1)).toBe(0);
    expect(calendarDepthLevel(-999)).toBe(0);
    expect(calendarDepthLevel(Number.NaN)).toBe(0);
    expect(calendarDepthLevel(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('1 类 = 第 1 档（浅）——「只记了体重」', () => {
    expect(calendarDepthLevel(1)).toBe(1);
  });

  it('2 类 = 第 2 档（深）——「记了饮食 + 体重」', () => {
    expect(calendarDepthLevel(2)).toBe(2);
  });

  it('≥3 类封顶在第 3 档，不因记更多类而无限加深', () => {
    expect(calendarDepthLevel(3)).toBe(3);
    expect(calendarDepthLevel(4)).toBe(3);
    expect(calendarDepthLevel(6)).toBe(3);
    expect(calendarDepthLevel(999)).toBe(3);
    expect(CALENDAR_DEPTH_MAX_LEVEL).toBe(3);
  });

  it('档位随类别数单调不减（0→1→2→3）', () => {
    const levels = [0, 1, 2, 3, 4, 5].map((n) => calendarDepthLevel(n));
    expect(levels).toEqual([0, 1, 2, 3, 3, 3]);
  });

  it('非法档位图例入参不会抛错（越界/非有限值钳制）', () => {
    // 仅验证函数对其自身定义域之外的输入稳健（前端图例用同一封顶值）
    expect(calendarDepthLevel(2.9)).toBe(2);
    expect(CALENDAR_DEPTH_MAX_LEVEL).toBeGreaterThan(0);
  });
});
