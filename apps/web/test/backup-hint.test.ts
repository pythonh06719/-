/**
 * 备份提示分档（R11.6 / AC-11.6.2 + AC-11.6.4 + AC-11.6.8）测试。
 *
 * 钉死三件事：
 * ① `backupHintCopy` 的档位：`null / 0 / 1 / 29 / 30 / 89 / 90 / 365` 全覆盖；
 * ② **12 个禁止词做成正则断言**（不靠人工过目）—— 危险 / 丢失 / 风险 / 即将 / 务必 /
 *    一定 / 立刻 / 现在就 / 紧急 / 警告 / 失效 / 备份以待万一；
 * ③ 与既有 `lastBackupLabel` **并存、不合并**（C6 基座是回归保护项）；
 *    主语是「距离上次备份」而非用户（AC-11.6.5），且以非指令性短语收尾。
 */

import { describe, expect, it } from 'vitest';

import { COPY, backupHintCopy, lastBackupLabel } from '@/lib/copy';

/** AC-11.6.4 的 12 个禁止词。 */
const BANNED_WORDS: readonly string[] = [
  '危险',
  '丢失',
  '风险',
  '即将',
  '务必',
  '一定',
  '立刻',
  '现在就',
  '紧急',
  '警告',
  '失效',
  '备份以待万一',
];

/** 额外兜底：不把天数写成欠账（AC-11.6.5）。 */
const DEBT_PHRASES: readonly RegExp[] = [
  /你已经\s*\d+\s*天没有/,
  /你已经\s*\d+\s*天没/,
  /该备份了/,
  /请立即/,
  /马上备份/,
];

describe('backupHintCopy 分档（AC-11.6.8）', () => {
  it('null / NaN / Infinity → null（从未备份沿用既有 dataBackupNever）', () => {
    expect(backupHintCopy(null)).toBeNull();
    expect(backupHintCopy(Number.NaN)).toBeNull();
    expect(backupHintCopy(Number.POSITIVE_INFINITY)).toBeNull();
    expect(backupHintCopy(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('< 30 天 → null（不展示任何额外提示）', () => {
    expect(backupHintCopy(0)).toBeNull();
    expect(backupHintCopy(1)).toBeNull();
    expect(backupHintCopy(29)).toBeNull();
    expect(backupHintCopy(29.9)).toBeNull();
  });

  it('30 ≤ days < 90 → 第一档（有 X 天了 · 什么时候方便）', () => {
    expect(backupHintCopy(30)).toBe('距离上次备份有 30 天了。数据都还在账号里，什么时候方便再留一份就行');
    expect(backupHintCopy(89)).toBe('距离上次备份有 89 天了。数据都还在账号里，什么时候方便再留一份就行');
  });

  it('days ≥ 90 → 第二档（随时可以 · 不留也没关系）', () => {
    expect(backupHintCopy(90)).toBe('距离上次备份 90 天了。随时可以再留一份，不留也没关系');
    expect(backupHintCopy(365)).toBe('距离上次备份 365 天了。随时可以再留一份，不留也没关系');
  });

  it('负数 / 小数向下取整，不抛错', () => {
    expect(backupHintCopy(-5)).toBeNull();
    expect(backupHintCopy(30.7)).toContain('有 30 天了');
    expect(backupHintCopy(120.2)).toContain('120 天了');
  });

  it('两档文案不同（分档确实生效）', () => {
    expect(backupHintCopy(30)).not.toBe(backupHintCopy(90));
  });
});

describe('backupHintCopy 文案红线（AC-11.6.4 / AC-11.6.5）', () => {
  /** 所有可能的输出（覆盖 0 ~ 400 天）。 */
  const allCopy: string[] = [];
  for (let days = 0; days <= 400; days += 1) {
    const line = backupHintCopy(days);
    if (line !== null) {
      allCopy.push(line);
    }
  }

  it('产生了足够多的样本（分档确实覆盖到了）', () => {
    expect(allCopy.length).toBeGreaterThan(300);
  });

  it.each(BANNED_WORDS)('禁止词「%s」一个都不命中', (word) => {
    const pattern = new RegExp(word);
    for (const line of allCopy) {
      expect(line).not.toMatch(pattern);
    }
  });

  it('不把天数写成欠账（主语是「距离上次备份」，不是「你已经 N 天没有」）', () => {
    for (const line of allCopy) {
      for (const pattern of DEBT_PHRASES) {
        expect(line).not.toMatch(pattern);
      }
      expect(line.startsWith('距离上次备份')).toBe(true);
      expect(line).not.toContain('你已经');
    }
  });

  it('以非指令性短语收尾（不出现感叹号与命令式）', () => {
    for (const line of allCopy) {
      expect(line).not.toContain('！');
      expect(line).not.toContain('!');
      expect(
        line.endsWith('什么时候方便再留一份就行') || line.endsWith('不留也没关系'),
      ).toBe(true);
    }
  });
});

describe('与既有 lastBackupLabel 并存（AC-11.6.1 回归保护）', () => {
  it('lastBackupLabel 三态文案完全不变', () => {
    expect(lastBackupLabel(null)).toBe(COPY.dataBackupNever);
    expect(lastBackupLabel(0)).toBe(COPY.dataBackupToday);
    expect(lastBackupLabel(3)).toBe('上次备份于 3 天前');
    expect(lastBackupLabel(122)).toBe('上次备份于 122 天前');
  });

  it('30 天时两行同时存在：事实陈述照旧，额外提示只是追加一行', () => {
    expect(lastBackupLabel(30)).toBe('上次备份于 30 天前');
    expect(backupHintCopy(30)).not.toBeNull();
    expect(backupHintCopy(30)).not.toBe(lastBackupLabel(30));
  });

  it('< 30 天时只有事实陈述，没有额外提示', () => {
    expect(lastBackupLabel(7)).toBe('上次备份于 7 天前');
    expect(backupHintCopy(7)).toBeNull();
  });
});
