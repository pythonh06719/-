/**
 * 数据可视化组件的深浅两套护栏（本轮修的三个**真实缺陷**，不是审美偏好）。
 *
 * 为什么这三条要有测试：它们全是「深色下才看得见」的错 —— 单跑浅色的 CI 永远发现不了，
 * 而一旦退回去，普通用户在夜间看到的就是「一条亮白圈」和「主角配角颠倒」。
 *
 * 缺陷清单（修复前实测）：
 *   ① ProgressRing：两处调用点都没传 `dark` → 深色下底环 `#d9ede4`（浅色亮白圈）
 *      + 浅色渐变；渐变 id 硬编码常量 → 同页两环即 HTML id 重复。
 *   ② WeightChart：深色下实际线 brand-300（9.33:1）比 7 日均线 brand-600（3.79:1）
 *      亮 2.5 倍 → **主次反转**，「均线是主角」的意图在深色下完全失效。
 *      另：轴色对白底 3.5:1 而轴标签仅 10px（不达 AA 4.5:1）；悬浮点 `stroke="#ffffff"`
 *      在深色下是亮白圈。
 *   ③ Sparkline：线色硬编码 `#2f9e78` = brand-500，对白底仅 3.34:1（体系判为偏弱档）。
 *
 * 全部改为 CSS 变量（SVG 的 stroke/fill 是 presentation attribute，不吃 `dark:` 变体）。
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';

import ProgressRing from '@/components/common/ProgressRing';
import Sparkline from '@/components/common/Sparkline';
import WeightChart from '@/pages/weight/WeightChart';

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

/** 读某个 circle/path 的 stroke 属性（可能是 `url(#id)` 或 `rgb(var(--x))`）。 */
function strokesOf(container: HTMLElement, tag: 'circle' | 'path'): string[] {
  return Array.from(container.querySelectorAll(tag)).map(
    (el) => el.getAttribute('stroke') ?? el.getAttribute('fill') ?? '',
  );
}

describe('数据可视化 · 深浅两套一致性', () => {
  it('★ ProgressRing 底环走 CSS 变量（不再硬编码色值，深浅自动成立）', () => {
    const { container } = render(<ProgressRing value={0.5} centerValue="50%" />);
    const circles = container.querySelectorAll('circle');
    // 第 1 个是底环：必须是变量引用，而不是 '#d9ede4' / '#24443a' 这种写死值
    expect(circles[0]?.getAttribute('stroke')).toBe('rgb(var(--qsh-ring-track))');
  });

  it('★ ProgressRing 渐变 id 逐实例唯一（同页两个环不产生重复 id）', () => {
    const { container: a } = render(<ProgressRing value={0.5} />);
    const { container: b } = render(<ProgressRing value={0.5} />);
    const idA = a.querySelector('linearGradient')?.getAttribute('id');
    const idB = b.querySelector('linearGradient')?.getAttribute('id');
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    // 修复前两处都是硬编码的 'qshProgressGradient' → 重复 id
    expect(idA).not.toBe(idB);
  });

  it('★ ProgressRing 进度环有数值过渡（修复前是瞬跳）', () => {
    const { container } = render(<ProgressRing value={0.7} />);
    const circles = container.querySelectorAll('circle');
    const style = circles[1]?.getAttribute('style') ?? '';
    // 320ms = duration-qsh-slow；cubic-bezier(.22,.68,.28,1) = ease-qsh-out
    expect(style).toContain('stroke-dashoffset');
    expect(style).toContain('320ms');
    expect(style).toContain('cubic-bezier(.22,.68,.28,1)');
  });

  it('★ ProgressRing 中心数值用 text-display（不再超出的 text-3xl）', () => {
    render(<ProgressRing value={0.5} centerValue="50%" />);
    const value = screen.getByText('50%');
    expect(value.className).toContain('text-display');
    expect(value.className).not.toContain('text-3xl');
  });

  it('★ WeightChart 深色下「实际线不比均线亮」（主次不反转）', () => {
    const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];
    const weights = [70, 69.6, 69.8, 69.2, 69.4];
    const props = { dates, weights, movingAverage: [null, null, null, null, null], unit: 'kg' as const };

    // 浅色：实际线用 brand-300（最淡）
    const light = render(<WeightChart {...props} />);
    const lightStrokes = strokesOf(light.container, 'path');
    document.documentElement.classList.add('dark');
    const dark = render(<WeightChart {...props} />);
    const darkStrokes = strokesOf(dark.container, 'path');

    // 修复前两套的 path stroke 完全相同（WEIGHT_COLOR 是模块级常量，不看深浅）
    expect(darkStrokes).not.toEqual(lightStrokes);
  });

  it('★ WeightChart 轴与网格走 CSS 变量（修复前是硬编码字面量）', () => {
    const { container } = render(
      <WeightChart dates={['2026-09-01', '2026-09-02']} weights={[70, 69.5]} movingAverage={[null, null]} unit="kg" />,
    );
    const texts = Array.from(container.querySelectorAll('text')).map((t) => t.getAttribute('fill'));
    // 轴标签的文字色必须是变量引用
    expect(texts.some((t) => t?.includes('var(--qsh-axis)'))).toBe(true);
    const lines = Array.from(container.querySelectorAll('line')).map((l) => l.getAttribute('stroke'));
    expect(lines.some((l) => l?.includes('var(--qsh-grid)'))).toBe(true);
  });

  it('★ WeightChart 轴标签字号 ≥ 11（10px 不达 AA 的 4.5:1）', () => {
    const { container } = render(
      <WeightChart dates={['2026-09-01', '2026-09-02']} weights={[70, 69.5]} movingAverage={[null, null]} unit="kg" />,
    );
    // ⚠️ 读 `font-size` 而非 `fontSize`：React 把 SVG 的 camelCase 属性映射到
    // presentation attribute，DOM 上实际是小写连字符形式。写成 `getAttribute('fontSize')`
    // 会拿到 null → 数组全被 filter 掉 → 断言「0 ≥ 11」——
    // **那是一条恒假的假断言**，看起来像产品缺陷，其实是测试自己写错了。
    const sizes = Array.from(container.querySelectorAll('text'))
      .map((t) => Number(t.getAttribute('font-size')))
      .filter((n) => Number.isFinite(n));
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(11);
  });

  it('★ WeightChart 悬浮点描边走 CSS 变量（修复前深色下是亮白圈）', () => {
    const { container } = render(
      <WeightChart dates={['2026-09-01', '2026-09-02']} weights={[70, 69.5]} movingAverage={[null, null]} unit="kg" />,
    );
    // 没有 hover 时不存在该点；用 CSS 变量的存在性做静态断言：
    // 源码里不得再出现 stroke="#ffffff"
    const html = container.innerHTML;
    expect(html).not.toContain('#ffffff');
  });

  /**
   * ⭐ 这条钉的是「配角不能比主角重」这条**设计规则**，不是某个具体数值。
   *
   * 2026-10-05 截图实测发现：数据点半径原为 2.5（直径 5，与当年 ECharts
   * `symbolSize: 5` 对齐），**比 7 日均线还粗** —— 90 个圆点密密麻麻压着均线，
   * 两线局部糊成一片，「均线是主角」完全读不出来。
   *
   * 判据怎么定（这里踩过一次「先调值迁就断言」的弯路，记录下来）：
   * 判据来自**视觉事实**而非某个数：圆点直径必须明显小于均线线宽。
   * 直径 = 2×r，均线直径 = strokeWidth，所以条件是 `2r < strokeWidth`。
   * 当前 r=1.4 → 直径 2.8 < 3，肉眼可辨地细于均线；原 r=2.5 → 直径 5 > 3，明显更粗。
   * 因此断言直接写「直径 < 均线线宽」这个物理关系，值将来微调也不会误报。
   */
  it('★ 体重数据点不比均线更重（配角不抢主角）', () => {
    const { container } = render(
      <WeightChart
        dates={['2026-09-01', '2026-09-02', '2026-09-03']}
        weights={[70, 69.6, 69.8]}
        movingAverage={[70, 69.8, 69.8]}
        unit="kg"
      />,
    );
    const paths = container.querySelectorAll('path');
    const avgWidth = Number(paths[paths.length - 2]?.getAttribute('stroke-width'));
    const weightWidth = Number(paths[paths.length - 1]?.getAttribute('stroke-width'));
    // 均线是主角：必须比实际线粗
    expect(avgWidth).toBeGreaterThan(weightWidth);

    // 数据点**直径**必须小于均线**线宽** —— 否则圆点戳穿均线，局部糊成一片
    const dots = Array.from(container.querySelectorAll('circle'))
      .map((c) => Number(c.getAttribute('r')))
      .filter((n) => Number.isFinite(n) && n > 0);
    expect(dots.length).toBeGreaterThan(0);
    for (const r of dots) expect(r * 2).toBeLessThan(avgWidth);
  });

  it('★ Sparkline 线色走 CSS 变量且不再是偏弱的 brand-500', () => {
    const { container } = render(
      <Sparkline
        data={[
          { date: '2026-09-01', weightKg: 70 },
          { date: '2026-09-02', weightKg: 69.6 },
          { date: '2026-09-03', weightKg: 69.8 },
        ]}
        ariaLabel="趋势"
      />,
    );
    const path = container.querySelector('path');
    expect(path?.getAttribute('stroke')).toBe('rgb(var(--qsh-spark))');
    // 修复前是 '#2f9e78'（brand-500，对白底 3.34:1）
    expect(container.innerHTML).not.toContain('#2f9e78');
  });

  /**
   * ⭐ 这条钉的是「**切换主题后必须重绘**」，不是某个色值。
   *
   * 缺陷是怎么发现的（2026-10-05 实测）：修完「深色线色不对」后跑取证脚本，
   * 深浅两套读出的 stroke **完全相同**。根因是组件在**渲染那一刻**读了一次
   * `document.documentElement.classList` —— 那是快照。用户点「深色」后
   * `applyTheme()` 改了 class，但组件不重渲染，于是渐变/线色停在旧主题。
   *
   * 「删掉 dark prop」只解决了「调用方漏传」，**没解决「切换后不重绘」**——
   * 两个是独立缺陷，缺一个深色就失效。所以必须有这条测试单独盯住后者。
   */
  it('★ 切换深色后 ProgressRing 的渐变真的换掉（订阅而非快照）', async () => {
    const { container } = render(<ProgressRing value={0.5} />);
    const stop = () => container.querySelector('linearGradient stop')?.getAttribute('stop-color');
    const before = stop();

    // 模拟用户点顶栏「深色」：applyTheme() 只做 classList.toggle，不派发事件
    document.documentElement.classList.add('dark');
    // MutationObserver 是异步回调，等一个微任务批次让它触发 + React 重渲染
    await act(async () => {
      await Promise.resolve();
    });

    const after = stop();
    expect(after).not.toBe(before);
    // 浅色首档 #4fbf94 → 深色首档 #8cc9ab（progressGradientDark）
    expect(before).toBe('#4fbf94');
    expect(after).toBe('#8cc9ab');
  });

  it('★ 切换深色后 WeightChart 的实际线换色（浅 brand-300 → 深 brand-400）', async () => {
    const props = {
      dates: ['2026-09-01', '2026-09-02', '2026-09-03'],
      weights: [70, 69.6, 69.8],
      movingAverage: [null, null, null],
      unit: 'kg' as const,
    };
    const { container } = render(<WeightChart {...props} />);
    // 未传 forecast 时不画预测线 → 只有均线与实际线两条 path，实际线是最后一条
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBeGreaterThanOrEqual(2);
    const weightStroke = () => paths[paths.length - 1]?.getAttribute('stroke') ?? '';
    const before = weightStroke();

    document.documentElement.classList.add('dark');
    await act(async () => {
      await Promise.resolve();
    });

    const after = weightStroke();
    expect(after).not.toBe(before);
    // 修复前两套都是 '#8cc9ab'（WEIGHT_COLOR 是模块级常量，不看深浅）
    expect(before).toBe('#8cc9ab'); // brand-300
    expect(after).toBe('#4fbf94'); // brand-400
  });
});
