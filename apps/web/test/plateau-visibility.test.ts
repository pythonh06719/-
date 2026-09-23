/**
 * 平台期卡展示频控的纯函数与本机存取测试（lib/plateau-visibility.ts，AC-11.1.6）。
 *
 * 钉死 PRD AC-11.1.6 的两条闸门 + 存取边界：
 * - **同一天最多展示一次**（今天已展示 → 不展示；昨天展示 → 展示）；
 * - **手动关闭后 7 天内不再自动出现**（0/1/3/6 天不展示；满 7 天起展示）；
 * - 天差按**本地日粒度**折算（跨午夜仍算同一天），坏值 / 缺失一律安全降级；
 * - `shouldShowPlateau` 是**纯函数**，不改动本机状态（频控不产生副作用）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  PLATEAU_DISMISS_DAYS,
  PLATEAU_DISMISSED_AT_KEY,
  PLATEAU_LAST_SHOWN_KEY,
  clearPlateauVisibility,
  daysSincePlateauDismissed,
  markPlateauDismissed,
  markPlateauShown,
  readPlateauVisibilityState,
  shouldShowPlateau,
} from '@/lib/plateau-visibility';
import { addDays, todayKey } from '@/lib/format';

/** 固定「现在」：本地 2026-09-12 20:00（与 settings-backup 测试同款，避免依赖运行机器时区）。 */
const NOW = new Date(2026, 8, 12, 20, 0, 0);
const TODAY = todayKey(NOW);

/** 造「N 天前的本地 20:00」再转 ISO（用本地时间构造，跨月自动归一化）。 */
function isoDaysAgo(days: number): string {
  return new Date(2026, 8, 12 - days, 20, 0, 0).toISOString();
}

/** 「现在」之后的第 N 天（本地 20:00），用于模拟跨天。 */
function daysAfterNow(days: number): Date {
  return new Date(2026, 8, 12 + days, 20, 0, 0);
}

describe('shouldShowPlateau（AC-11.1.6 频控）', () => {
  it('无任何本机状态 → 展示', () => {
    expect(shouldShowPlateau({ shownDate: null, dismissedAt: null }, NOW)).toBe(true);
  });

  it('同一天已展示过 → 不展示；昨天展示过 → 展示', () => {
    expect(shouldShowPlateau({ shownDate: TODAY, dismissedAt: null }, NOW)).toBe(false);
    expect(shouldShowPlateau({ shownDate: addDays(TODAY, -1), dismissedAt: null }, NOW)).toBe(true);
  });

  it('关闭后 7 天内 → 不展示（当天 / 第 1 / 3 / 6 天）；满 7 天起 → 展示', () => {
    for (const days of [0, 1, 3, 6]) {
      expect(shouldShowPlateau({ shownDate: null, dismissedAt: isoDaysAgo(days) }, NOW)).toBe(false);
    }
    expect(shouldShowPlateau({ shownDate: null, dismissedAt: isoDaysAgo(7) }, NOW)).toBe(true);
    expect(shouldShowPlateau({ shownDate: null, dismissedAt: isoDaysAgo(30) }, NOW)).toBe(true);
  });

  it('两个闸门同时命中（今天展示过 + 刚关闭）→ 不展示', () => {
    expect(shouldShowPlateau({ shownDate: TODAY, dismissedAt: isoDaysAgo(0) }, NOW)).toBe(false);
  });

  it('关闭时间戳无法解析 → 视为未关闭（安全降级，不误伤）', () => {
    expect(shouldShowPlateau({ shownDate: null, dismissedAt: 'not-a-date' }, NOW)).toBe(true);
  });

  it('关闭时间戳在未来（时钟回拨）→ 按「刚关闭」处理，宁可少弹', () => {
    expect(shouldShowPlateau({ shownDate: null, dismissedAt: isoDaysAgo(-3) }, NOW)).toBe(false);
  });

  it('PLATEAU_DISMISS_DAYS 固定为 7（AC 明文）', () => {
    expect(PLATEAU_DISMISS_DAYS).toBe(7);
  });

  it('是纯函数：调用不改动本机状态', () => {
    window.localStorage.setItem(PLATEAU_LAST_SHOWN_KEY, TODAY);
    const before = window.localStorage.getItem(PLATEAU_LAST_SHOWN_KEY);
    shouldShowPlateau(readPlateauVisibilityState(), NOW);
    expect(window.localStorage.getItem(PLATEAU_LAST_SHOWN_KEY)).toBe(before);
  });
});

describe('daysSincePlateauDismissed（本地日粒度）', () => {
  it('null / 坏值 → null；否则按本地日差折算', () => {
    expect(daysSincePlateauDismissed(null, NOW)).toBeNull();
    expect(daysSincePlateauDismissed('not-a-date', NOW)).toBeNull();
    // 本地 2026-09-12 00:30（刚过午夜，仍是「今天」→ 0 天）
    expect(daysSincePlateauDismissed(new Date(2026, 8, 12, 0, 30).toISOString(), NOW)).toBe(0);
    expect(daysSincePlateauDismissed(new Date(2026, 8, 9, 23, 0).toISOString(), NOW)).toBe(3);
  });
});

describe('读取 / 写入 / 清除（localStorage）', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('markPlateauShown 写入「今天的本地日期键」，重复调用幂等', () => {
    markPlateauShown(NOW);
    markPlateauShown(NOW);
    expect(window.localStorage.getItem(PLATEAU_LAST_SHOWN_KEY)).toBe(TODAY);
  });

  it('markPlateauDismissed 写入 ISO 时间戳', () => {
    markPlateauDismissed(NOW);
    expect(window.localStorage.getItem(PLATEAU_DISMISSED_AT_KEY)).toBe(NOW.toISOString());
  });

  it('readPlateauVisibilityState 一次读出两个键', () => {
    markPlateauShown(NOW);
    markPlateauDismissed(NOW);
    expect(readPlateauVisibilityState()).toEqual({
      shownDate: TODAY,
      dismissedAt: NOW.toISOString(),
    });
  });

  it('clearPlateauVisibility 同时清掉两个键（账号硬删除用）', () => {
    markPlateauShown(NOW);
    markPlateauDismissed(NOW);
    clearPlateauVisibility();
    expect(window.localStorage.getItem(PLATEAU_LAST_SHOWN_KEY)).toBeNull();
    expect(window.localStorage.getItem(PLATEAU_DISMISSED_AT_KEY)).toBeNull();
    expect(readPlateauVisibilityState()).toEqual({ shownDate: null, dismissedAt: null });
  });

  it('写入后判定闭环：展示 → 当天不再展示 → 关闭后 7 天内不再展示', () => {
    // 首次展示
    expect(shouldShowPlateau(readPlateauVisibilityState(), NOW)).toBe(true);
    markPlateauShown(NOW);
    // 同一天再进
    expect(shouldShowPlateau(readPlateauVisibilityState(), NOW)).toBe(false);
    // 次日仍会展示（除非用户关闭）
    expect(shouldShowPlateau(readPlateauVisibilityState(), daysAfterNow(1))).toBe(true);
    // 用户关闭 → 7 天内都不展示
    markPlateauDismissed(NOW);
    expect(shouldShowPlateau(readPlateauVisibilityState(), daysAfterNow(1))).toBe(false);
    expect(shouldShowPlateau(readPlateauVisibilityState(), daysAfterNow(6))).toBe(false);
    // 满 7 天 → 恢复
    expect(shouldShowPlateau(readPlateauVisibilityState(), daysAfterNow(7))).toBe(true);
  });
});
