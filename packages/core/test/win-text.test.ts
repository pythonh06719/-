/**
 * 「体重之外的变化」文本清洗单测（core/win/text.ts，R11.4 / AC-11.4.9）。
 *
 * 覆盖架构文档 §5.2 单测表全部边界：空 / 空白 / 换行折叠 / 首尾空白 /
 * 恰好 60 字 / 61 字（不截断）/ emoji 码点 / 全角空格。
 */

import { describe, expect, it } from 'vitest';

import {
  WIN_TEXT_MAX_LENGTH,
  checkWinText,
  normalizeWinText,
  winTextLength,
} from '../src/index';

describe('normalizeWinText（清洗）', () => {
  it('非字符串 → 空串', () => {
    expect(normalizeWinText(undefined as unknown as string)).toBe('');
    expect(normalizeWinText(null as unknown as string)).toBe('');
  });

  it('首尾空白被 trim', () => {
    expect(normalizeWinText('  今天爬楼没那么喘了  ')).toBe('今天爬楼没那么喘了');
  });

  it('换行 / 制表符折叠为单个空格（AC-11.4.9）', () => {
    expect(normalizeWinText('今天\n爬楼\n没那么喘了')).toBe('今天 爬楼 没那么喘了');
    expect(normalizeWinText('今天\t爬楼')).toBe('今天 爬楼');
  });

  it('全角空格视为空白，被 trim / 折叠', () => {
    expect(normalizeWinText('　裤子松了一圈　')).toBe('裤子松了一圈');
    expect(normalizeWinText('裤子　松了一圈')).toBe('裤子 松了一圈');
  });
});

describe('winTextLength（码点计数）', () => {
  it('中文 1 字 = 1 码点', () => {
    expect(winTextLength('今天爬楼没那么喘了')).toBe(9);
  });

  it('emoji（代理对）算 1 个码点', () => {
    expect(winTextLength('😊')).toBe(1);
    expect(winTextLength('今天😊')).toBe(3);
  });

  it('非字符串 → 0', () => {
    expect(winTextLength(undefined as unknown as string)).toBe(0);
  });
});

describe('checkWinText（校验 + 清洗一步）', () => {
  it('纯空格 / 空串 / 换行 → reason=empty', () => {
    expect(checkWinText('')).toEqual({ ok: false, reason: 'empty', length: 0 });
    expect(checkWinText('   ')).toEqual({ ok: false, reason: 'empty', length: 0 });
    expect(checkWinText('\n\t　')).toEqual({ ok: false, reason: 'empty', length: 0 });
  });

  it('恰好 60 个中文字 → ok:true', () => {
    const text = '记'.repeat(60);
    const result = checkWinText(text);
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.text).toBe(text);
    expect(WIN_TEXT_MAX_LENGTH).toBe(60);
  });

  it('61 个中文字 → reason=tooLong 且**不截断**（AC-11.4.2）', () => {
    const text = '记'.repeat(61);
    const result = checkWinText(text);
    expect(result).toEqual({ ok: false, reason: 'tooLong', length: 61 });
  });

  it('emoji 计数：59 个中文 + 1 个 emoji（代理对）= 60 码点 → ok', () => {
    const result = checkWinText(`${'记'.repeat(59)}😊`);
    expect(result.ok).toBe(true);
  });

  it('60 个中文 + 1 个 emoji = 61 码点 → tooLong（length=61）', () => {
    const result = checkWinText(`${'记'.repeat(60)}😊`);
    expect(result).toEqual({ ok: false, reason: 'tooLong', length: 61 });
  });

  it('ok 时返回清洗后的文本（入库用它）', () => {
    const result = checkWinText('  今天\n爬楼没那么喘了　');
    expect(result.ok === true && result.text).toBe('今天 爬楼没那么喘了');
  });

  it('自定义上限生效（仍不截断）', () => {
    expect(checkWinText('一二三四五', 3)).toEqual({ ok: false, reason: 'tooLong', length: 5 });
    expect(checkWinText('一二三', 3)).toEqual({ ok: true, text: '一二三' });
  });
});
