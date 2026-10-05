/**
 * 卡片描边守卫：卡面上不许再叠任何 `ring-*` 工具类。
 *
 * ## 被钉住的约定
 *
 * `src/styles/index.css` 里 `.qsh-surface` / `.qsh-surface-warm` / `.qsh-action-card`
 * 是全站唯一的三种卡面类，描边的**真源**在它们自身（以及 `theme/dark.css` 的深色覆盖）：
 *
 * ```css
 * .qsh-surface        { @apply … ring-1 ring-brand-100; }   ← 排在 @tailwind utilities 之后
 * html.dark .qsh-surface { --tw-ring-color: #24443a; }
 * ```
 *
 * ⚠️ **关键的坑**：这三个类是**排在 `@tailwind utilities` 之后的普通 CSS 规则**。
 * 同特异性下后写的赢，所以它们会盖掉**任何** ring 工具类 —— 而且不止颜色
 * （`--tw-ring-color`），`@apply ring-1` 还把宽度（`--tw-ring-shadow` 里的 `1px`）一起锁死。
 * 也就是说：在卡面上写 `ring-2 ring-brand-500 dark:ring-brand-400` 是**完全无效**的，
 * 连「变粗」都不会发生。
 *
 * 真实代价：`DiaryPage` 拖拽排序餐次的**落区高亮**就是这么写的，于是深浅两套模式下
 * 都从未显示过（注释里还算了 3.34:1 / 6.42:1，全是空谈）。
 * `HabitsPage.tsx:190` 已打卡态早就踩过同一条坑 —— 当时的解法是绕开卡面类手写一套。
 * 本轮给卡面补了正式的状态修饰符 `.qsh-surface-drop`，别再各绕各的。
 *
 * 历史上还有 60 处在卡面上写 `dark:ring-slate-700`（形如 `className="qsh-surface p-5
 * dark:ring-slate-700"`），同样是死声明：Tailwind 生成的选择器是
 * `.dark\:ring-slate-700:is(.dark *)`（(0,2,0)），低于 `html.dark .qsh-surface`（(0,2,1)）。
 *
 * ## 为什么「只能是静态扫描」
 *
 * **不能写成运行时断言**（渲染组件后检查 `getComputedStyle(...).boxShadow` 之类）：
 * jsdom **不做 CSS 层叠计算**，`vitest.config.ts` 里更是 `css: false`（连样式表都不加载），
 * 自定义属性（`--tw-ring-color`）在 jsdom 里读出来一律是空串。
 * 也就是说：运行时根本测不出「谁覆盖了谁」—— 测出来的一定是假绿。
 *
 * 这条守卫要钉的恰恰是**层叠里的胜负关系**，它只存在于源码文本与 CSS 产物中，
 * 因此只能扫源码。
 *
 * ## 扫描器的形状（为什么既按行扫、又按 className 块扫）
 *
 * - **按行扫**：吃单行的 `className="…"`。
 * - **按块扫**：`className={[ … ].join(' ')}` 这种**跨行数组**写法，按行扫不到 ——
 *   上面那个落区高亮正是这么漏掉的。块扫描覆盖它。
 * - 两者取并集：块扫描遇到 `className={`…${x}…`}`（内含 `{}`）会在第一个 `}` 截断，
 *   按行扫可以补上；按行扫漏掉的跨行数组则由块扫描补上。漏报比误报危险得多。
 *
 * ## 不断言什么
 *
 * 不反向断言「那 29 处 chip 描边必须还在」。它们**不带**卡面类，拿不到卡面的深色覆盖，
 * 只能靠自己的 `dark:ring-slate-700` —— 但把几十处具体行号钉进测试，
 * 将来任何一次组件改名 / 抽取都会误报，守卫就变成负担而非保护。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 三种卡面类（都会锁死 ring 的宽度与颜色）。 */
const CARD_CLASS = /qsh-surface|qsh-action-card/;
/**
 * 任何 ring 工具类。
 * `ring-offset-*` **不算** —— 卡面类没有声明 `--tw-ring-offset-width`，它不会被盖掉。
 */
const RING_UTILITY = /\bring-(?!offset-)/;

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

interface Offender {
  readonly relPath: string;
  readonly line: number;
  readonly text: string;
}

/** 取 `className` 表达式块：`"…"` / `'…'` / `{…}`（不跨嵌套 `{}`）。 */
function classBlocks(source: string): Array<{ text: string; line: number }> {
  const blocks: Array<{ text: string; line: number }> = [];
  for (const match of source.matchAll(/className=(?:"[^"]*"|'[^']*'|\{[^{}]*\})/g)) {
    const line = source.slice(0, match.index).split('\n').length;
    blocks.push({ text: match[0], line });
  }
  return blocks;
}

/** 扫一个文件：行扫描 + 块扫描取并集。 */
function scanFile(absPath: string, relPath: string): { offenders: Offender[]; cardLines: number; blocks: number } {
  const source = readFileSync(absPath, 'utf8');
  const offenders: Offender[] = [];
  let cardLines = 0;

  source.split('\n').forEach((text, index) => {
    if (CARD_CLASS.test(text)) cardLines += 1;
    if (CARD_CLASS.test(text) && RING_UTILITY.test(text)) {
      offenders.push({ relPath, line: index + 1, text: text.trim() });
    }
  });

  for (const block of classBlocks(source)) {
    if (CARD_CLASS.test(block.text) && RING_UTILITY.test(block.text)) {
      const text = block.text.replace(/\s+/g, ' ').trim();
      // 行扫描可能已记过同一处（单行形态），去重
      if (!offenders.some((o) => o.line === block.line && o.text === text)) {
        offenders.push({ relPath, line: block.line, text });
      }
    }
  }

  return { offenders, cardLines, blocks: classBlocks(source).length };
}

describe('卡片描边：描边真源只在卡面类自身 / theme/dark.css，卡面不许再叠 ring-*', () => {
  const files = collectTsx(SRC_ROOT);
  const scans = files.map((abs) =>
    scanFile(abs, abs.slice(SRC_ROOT.length + 1).replace(/\\/g, '/')),
  );

  it('★ 自证：扫描器真的扫到了 .tsx、卡面用法与 className 块（否则下面全是假绿）', () => {
    // 这条不是业务断言，是**守卫自身的健康检查**：
    // 若 cwd 不对（忘记从 apps/web 跑）或遍历逻辑坏了，files 会是空数组，
    // 下一条 `toEqual([])` 会永远通过 —— 用几句断言把「假绿」这条路堵死。
    // 阈值刻意取得宽松（当前实测 59 文件 / 117 行卡面类 / 数百个 className 块）：
    // 这里要挡的是「一个都没扫到」的假绿，不是要给数量设下限。
    expect(files.length).toBeGreaterThan(20);
    expect(scans.reduce((sum, s) => sum + s.cardLines, 0)).toBeGreaterThan(50);
    expect(scans.reduce((sum, s) => sum + s.blocks, 0)).toBeGreaterThan(50);
  });

  it('★ 不存在「同一 className 表达式里同时出现卡面类与 ring-*」的写法', () => {
    const offenders = scans.flatMap((scan) =>
      scan.offenders.map((o) => `${o.relPath}:${o.line}  ${o.text}`),
    );

    const hint = offenders.length
      ? `\n\n以下位置在卡面上又叠了 ring 工具类：\n${offenders.join('\n')}\n\n` +
        '卡面类是排在 `@tailwind utilities` 之后的普通 CSS 规则，会把 ring 的**颜色和宽度**\n' +
        '一起盖掉 —— 写在卡面上的 ring 工具类完全无效。\n' +
        '要表达卡面的某个状态（如拖放落区高亮），请在 styles/index.css 里加\n' +
        '`.qsh-surface.<修饰符>` 这样的状态类（深色档同步写进 theme/dark.css）。'
      : '';

    expect(offenders, hint).toEqual([]);
  });
});
