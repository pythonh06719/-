import { describe, expect, it } from 'vitest';
import { shareCardFileName } from '@/components/feedback/ShareCard';

/**
 * 分享卡片纯函数单测（三期）。
 *
 * Canvas 绘制本体依赖浏览器 2D 上下文（jsdom 不提供），此处覆盖文件名生成；
 * 隐私约束（K10）由实现保证：卡片只含变化量，不含邮箱 / 绝对体重。
 */
describe('shareCardFileName', () => {
  it('周起止生成稳定 PNG 文件名', () => {
    expect(shareCardFileName('09-06', '09-12')).toBe('qinglife-week-09-06_09-12.png');
  });

  it('包含非法路径字符的输入也不会产生路径分隔符', () => {
    const name = shareCardFileName('a/b', 'c\\d');
    expect(name).not.toContain('/');
    expect(name.endsWith('.png')).toBe(true);
  });
});
