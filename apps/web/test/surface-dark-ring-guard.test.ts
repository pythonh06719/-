/**
 * 卡片描边守卫：`qsh-surface` 卡面上不许再叠 `dark:ring-*`。
 *
 * ## 被钉住的约定
 *
 * `src/styles/index.css` 的 `.qsh-surface` 是全站唯一的卡片表面类，深色档的**描边真源**是
 * `src/theme/dark.css` 里的：
 *
 * ```css
 * html.dark .qsh-surface {
 *   background-color: #16241f;
 *   border-color: #24443a;
 *   --tw-ring-color: #24443a;    ← 深色卡片描边在这里，且只在这里
 * }
 * ```
 *
 * 历史上有 60 处在卡面的 className 里额外写了 `dark:ring-slate-700`
 * （形如 `className="qsh-surface p-5 dark:ring-slate-700"`）。它们是**不起作用却会误导人**的死声明：
 * Tailwind 为它生成的选择器是 `.dark\:ring-slate-700:is(.dark *)`，特异度 (0,2,0)；
 * 而 `html.dark .qsh-surface` 是 (0,2,1)。后者更高，且在打包产物里位置也靠后，
 * 两条路都赢 —— 实测（headless Chromium 读 `getComputedStyle`）深色下
 * `--tw-ring-color` 为 `#24443a` 而非 slate 的 `#334155`。
 *
 * 留着它们的真实代价不是「多一个无用字符」，而是**看起来像是生效的**：
 * 下一个改深色卡片的人会以为描边写在 JSX 里，改完发现不生效，或反过来删掉 `dark.css` 的覆盖。
 * 真源必须只有一个，重复的第二处即使是死代码也要删掉。
 *
 * ## 为什么「只能是静态扫描」
 *
 * **不能写成运行时断言**（渲染组件后检查 `getComputedStyle(...).boxShadow` 之类）：
 * jsdom **不做 CSS 层叠计算**。它不实现 `@media` 之外的属性层叠，
 * `vitest.config.ts` 里更是 `css: false`（连样式表都不加载），
 * 自定义属性（`--tw-ring-color`）在 jsdom 里读出来一律是空串。
 * 也就是说：运行时根本测不出「谁覆盖了谁」—— 测出来的一定是假绿。
 *
 * 这条守卫要钉的恰恰是**层叠里的胜负关系**（同一张卡上不许存在第二个会挑战 `dark.css` 的深色描边），
 * 它只存在于源码文本与 CSS 产物中，因此只能用 `readFileSync` + 正则扫源码。
 *
 * ## 为什么不断言反向（保留的那些 chip 描边必须还在）
 *
 * 全站另有若干处非卡面的 `ring-1 ring-brand-100 ... dark:ring-slate-700`
 * （周报 Tab、已打卡习惯条、日历格等 chip / 次级按钮），它们**不带** `qsh-surface`，
 * 拿不到 `dark.css` 的深色覆盖，只能靠自己的 `dark:ring-slate-700` —— 删了会在墨绿底上
 * 出现一条浅色亮边。反向断言换句说话就是把「这几十处具体行号」钉进测试：
 * 将来任何一次正常的组件改名 / 抽取都会让它误报，守卫就变成了负担而非保护。
 * 因此这里只钉「卡面不许叠」这一条。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 单个待检查文件的扫描结果。 */
interface FileScan {
  /** 相对 `src/` 的路径，用于失败信息里定位。 */
  readonly relPath: string;
  /** 违规行：`行号 -> 该行原文`。 */
  readonly violations: ReadonlyArray<{ readonly line: number; readonly text: string }>;
  /** 该文件里 `qsh-surface` 出现的行数，用于自证扫描器真的读到了内容。 */
  readonly surfaceLines: number;
}

/** `qsh-surface` / `qsh-surface-warm` —— 唯一受 `dark.css` 深色描边覆盖的卡面类。 */
const SURFACE_CLASS = /qsh-surface/;
/** 任何写在 JSX 上的深色描边类。 */
const DARK_RING_CLASS = /dark:ring-/;

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

/** 扫一个文件，返回违规行清单。 */
function scanFile(absPath: string, relPath: string): FileScan {
  const lines = readFileSync(absPath, 'utf8').split('\n');
  const violations: Array<{ line: number; text: string }> = [];
  let surfaceLines = 0;

  lines.forEach((text, index) => {
    if (SURFACE_CLASS.test(text)) surfaceLines += 1;
    // 同一行同时出现「卡面类」与「深色描边」= 在自己的卡上叠了第二个真源。
    if (SURFACE_CLASS.test(text) && DARK_RING_CLASS.test(text)) {
      violations.push({ line: index + 1, text: text.trim() });
    }
  });

  return { relPath, violations, surfaceLines };
}

describe('卡片描边：深色描边的真源只有 theme/dark.css，卡面不许再叠 dark:ring-*', () => {
  const files = collectTsx(SRC_ROOT);
  const scans: FileScan[] = files.map((abs) =>
    scanFile(abs, abs.slice(SRC_ROOT.length + 1).replace(/\\/g, '/')),
  );

  it('★ 自证：扫描器真的扫到了 .tsx 与 qsh-surface 用法（否则下面全是假绿）', () => {
    // 这条不是业务断言，是**守卫自身的健康检查**：
    // 若 cwd 不对（忘记从 apps/web 跑）或遍历逻辑坏了，files 会是空数组，
    // 下一条 `toEqual([])` 会永远通过 —— 用一句断言把「假绿」这条路堵死。
    // 阈值刻意取得宽松（当前实测 59 个文件 / 117 行 qsh-surface）：这里要挡的是
    // 「一个都没扫到」的假绿，不是要给文件数量设下限 —— 卡太紧会在正常增删文件后误报。
    expect(files.length).toBeGreaterThan(20);

    const totalSurfaceLines = scans.reduce((sum, s) => sum + s.surfaceLines, 0);
    expect(totalSurfaceLines).toBeGreaterThan(50);
  });

  it('★ 不存在「同一行同时出现 qsh-surface 与 dark:ring-」的写法', () => {
    const offenders = scans.flatMap((scan) =>
      scan.violations.map((v) => `${scan.relPath}:${v.line}  ${v.text}`),
    );

    const hint = offenders.length
      ? `\n\n以下位置在自己的 qsh-surface 卡上又叠了一层深色描边：\n${offenders.join('\n')}\n\n` +
        '深色卡面描边请在 src/theme/dark.css 的 `html.dark .qsh-surface` 里改，' +
        '不要在 JSX 上再声明一层 —— 它的特异度低于 dark.css，是看起来生效、其实无效的死声明。'
      : '';

    expect(offenders, hint).toEqual([]);
  });
});
