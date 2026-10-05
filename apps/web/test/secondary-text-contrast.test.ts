/**
 * 次级文字对比度守卫：浅色档不许裸用 `text-slate-400`。
 *
 * ## 被钉住的事实
 *
 * `slate-400` = `#94a3b8`，对卡片 / 面板白底只有 **2.56:1**，远低于 AA 的 4.5:1。
 * 深色档则相反：`#94a3b8` 落在卡片 `#16241f` 上是 6.34:1、落在面板 `slate-800` 上是 5.77:1，
 * **达标** —— 所以 `dark:text-slate-400` 是合法的、而且是全站最常见的写法
 * （实测 192 处 `text-slate-400` 里有 190 处带 `dark:` 前缀）。
 *
 * 换句话说：问题从不是「slate-400 不能用」，而是**浅色档不能用**。
 * 这条守卫钉的正是这个前缀。
 *
 * 历史上有 2 处漏网（`MealComposer.tsx` 的 ODbL 署名、`FootprintView.tsx` 的星期头），
 * 且都写成了 `text-slate-400 dark:text-slate-500` —— 后者在深色下只有 3.08:1，
 * **两套主题同时不达标**。署名尤其不该看不清（ODbL 是 Open Food Facts 的许可要求）。
 *
 * ⚠️ 别被「全仓 192 处 text-slate-400」这个数字吓到去批量改色：
 * 190 处是 `dark:` 前缀，浅色下根本不生效，改了只会把刻意弱化的层级压平。
 *
 * ## 为什么「只能是静态扫描」
 *
 * 同 `surface-dark-ring-guard.test.ts` 的理由：jsdom 不做 CSS 层叠计算，
 * `vitest.config.ts` 更是 `css: false`（连样式表都不加载），渲染出来读颜色一律假绿。
 * 对比度的**判据是色值**（能静态算）而**不是渲染结果**，所以扫源码文本就够了。
 *
 * ## 不断言什么
 *
 * - 不断言 `text-slate-300` / `text-slate-600`：存在刻意留白的用法
 *   （`FootprintView` 无记录日的日期数字「留白」语义、`MealComposer` 未收藏 ☆ 的两态指示），
 *   且都在 `aria-hidden` 的装饰上。把它们钉死会逼人放弃「不焦虑」的层级设计。
 * - 不断言 `dark:text-slate-500` 的处数：那会把「未收藏 ☆」这一个有意的例外写死成行号。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 浅色档的 `text-slate-400`：用**后顾断言**排除 `dark:text-slate-400`。
 *
 * ⚠️ 这个 `(?<!dark:)` 是本守卫成立与否的关键 —— 写漏了就会把 190 处合法用法
 * 全判违规，而「全判违规」看上去像「抓到很多问题」、其实是判据写错了。
 * 下面的自证断言专门检查它。
 */
const LIGHT_ONLY_SLATE_400 = /(?<!dark:)text-slate-400/g;
const ANY_SLATE_400 = /text-slate-400/g;
const DARK_SLATE_400 = /dark:text-slate-400/g;

const SRC_ROOT = resolve(process.cwd(), 'src');

/** 递归列出 `src/` 下所有 `.tsx`（手写遍历，不引 glob 依赖）。 */
function collectTsx(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTsx(full));
    } else if (entry.name.endsWith('.tsx')) {
      found.push(full);
    }
  }
  return found;
}

describe('次级文字对比度：浅色档不许用 slate-400（白底 2.56:1，AA 失败）', () => {
  const files = collectTsx(SRC_ROOT);
  const hits: Array<{ readonly rel: string; readonly line: number; readonly text: string }> = [];
  let totalSlate400 = 0;
  let darkSlate400 = 0;

  for (const abs of files) {
    const rel = abs.slice(SRC_ROOT.length + 1).replace(/\\/g, '/');
    readFileSync(abs, 'utf8')
      .split('\n')
      .forEach((text, index) => {
        totalSlate400 += (text.match(ANY_SLATE_400) ?? []).length;
        darkSlate400 += (text.match(DARK_SLATE_400) ?? []).length;
        if (LIGHT_ONLY_SLATE_400.test(text)) {
          hits.push({ rel, line: index + 1, text: text.trim() });
        }
      });
  }

  it('★ 自证：扫描器读到了内容，且后顾断言确实只排除了 dark: 前缀', () => {
    // 三件事各自堵一类假绿：
    // ① 文件数 > 20：cwd 不对（忘记从 apps/web 跑）时 files 为空，下面会永远通过；
    // ② 总数 > 100：证明真的读到源码文本，而不是扫了个空目录；
    // ③ dark 数 == 总数 - 命中数：这条最关键 —— 若 `(?<!dark:)` 写错，命中数会暴涨、
    //    恒等式立刻不成立，而不是「看起来抓到一大批问题」。
    expect(files.length).toBeGreaterThan(20);
    expect(totalSlate400).toBeGreaterThan(100);
    expect(darkSlate400).toBe(totalSlate400 - hits.length);
  });

  it('★ 不存在浅色档生效的 text-slate-400（深色档不受此限）', () => {
    const offenders = hits.map((h) => `${h.rel}:${h.line}  ${h.text}`);

    const hint = offenders.length
      ? `\n\n以下位置在浅色档用了 slate-400（#94a3b8，对白底 2.56:1，AA 失败）：\n${offenders.join('\n')}\n\n` +
        '改成 `text-slate-500 dark:text-slate-400`（浅 4.76:1 / 深 5.77~6.34:1）。\n' +
        '注意不要只改一半：配套的 `dark:text-slate-500` 在深色下只有 3.08:1，同样不达标。'
      : '';

    expect(offenders, hint).toEqual([]);
  });
});
