/**
 * 静态守卫：`DEFAULT_WATER_GOAL_ML` 只允许有一处**定义**（`packages/core/src/water/goal.ts`）。
 *
 * ## 为什么需要它
 *
 * 这个常量曾经在 web 侧有第二份：`apps/web/src/theme/tokens.ts` 里也写过 `= 2000`。
 * 两份相邻的常量今天恰好同值，所以任何测试都查不出问题；但它们是**两个作者**：
 * 改口径要同时想到 core 与 theme，漏一个就会出现「同一天、同一用户、两个目标」。
 * 现在 web 侧改成从 core re-export，`DashboardPage` 也一并统一到 `@qsh/core`。
 *
 * ## 为什么是静态扫描而不是 import 比较
 *
 * 「两边 import 同一个值」这种断言会被 `export from` 的写法绕过去，而且只有当
 * 两份都存在时才有意义。这里要守的是更硬的一条：**源码里不许出现第二个常量定义**。
 *
 * ## ⚠️ 自证（否则最容易变成假绿）
 *
 * 「扫到一个定义就 pass」在扫到 0 个文件时也成立 —— 路径写错、目录被重命名、
 * glob 漏了都照样绿。所以下面额外断言：确实读到了一批源码文件、总字符数够多、
 * 两个目录都得有货，并且 core 那份定义必须真实存在。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
/** 仓库根（`apps/web/test` 往上三级）—— 顺手写死中间目录很容易数错 `..`，统一由它派生。 */
const repoRoot = resolve(here, '../../..');
const webSrc = resolve(repoRoot, 'apps/web/src');
const coreSrc = resolve(repoRoot, 'packages/core/src');

/** 唯一允许的常量定义位置（相对仓库根）。 */
const CANONICAL_DEFINITION = 'packages/core/src/water/goal.ts';

/** 匹配「常量定义」：前面不是 `.` 或标识符、`DEFAULT_WATER_GOAL_ML` 后面紧跟单个 `=`。 */
const DEFINITION_RE = /(?:^|[^\w.])DEFAULT_WATER_GOAL_ML\s*=[^=]/;

/**
 * 去掉注释后再扫 —— 否则一段解释性注释里提到「xxx = 」就会被判成定义。
 * （第一版就踩了这个：tokens.ts 的说明文案把自己变成了「第二处定义」。）
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // 行注释；用 `[^:]` 护住 `https://` 这类 URL，避免把整行删掉
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** 忽略 dist / build 产物与测试夹具以外的东西——这两个目录里没有产物，这里只是兜个底。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']);

interface SourceFile {
  /** 相对仓库根的路径 */
  relPath: string;
  content: string;
}

/** 递归收集源码文件（只取 ts / tsx）。 */
function collectSources(dir: string): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        if (SKIP_DIRS.has(entry)) {
          continue;
        }
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) {
        continue;
      }
      found.push({
        relPath: full.slice(repoRoot.length + 1).replace(/\\/g, '/'),
        content: readFileSync(full, 'utf8'),
      });
    }
  };
  walk(dir);
  return found;
}

const scanned = [...collectSources(webSrc), ...collectSources(coreSrc)];

describe('静态守卫：DEFAULT_WATER_GOAL_ML 的唯一真源', () => {
  it('自证：确实扫到了源码（否则下面那条「只有一处定义」可以在扫到 0 个文件时蒙混通过）', () => {
    const totalChars = scanned.reduce((sum, file) => sum + file.content.length, 0);

    expect(scanned.length, '扫到的源码文件太少 —— 路径写错或目录被移走了').toBeGreaterThan(100);
    expect(totalChars, '扫到的源码字符数太少 —— 同上，别让扫描悄悄失效').toBeGreaterThan(100_000);
    // 两个目录都得有货，少扫一个目录也会让「只有一处定义」失去意义
    expect(scanned.some((file) => file.relPath.startsWith('apps/web/src/'))).toBe(true);
    expect(scanned.some((file) => file.relPath.startsWith('packages/core/src/'))).toBe(true);
    // core 那份定义本身必须真的存在（不是「压根没这个常量」）
    const canonical = scanned.find((file) => file.relPath === CANONICAL_DEFINITION);
    expect(canonical, `没找到 ${CANONICAL_DEFINITION}`).toBeDefined();
    expect(canonical?.content).toContain('export const DEFAULT_WATER_GOAL_ML');
  });

  it('apps/web/src 与 packages/core/src 里只有一处 DEFAULT_WATER_GOAL_ML 常量定义', () => {
    const definitions = scanned
      .filter((file) => DEFINITION_RE.test(stripComments(file.content)))
      .map((file) => file.relPath);

    // re-export / import 不算定义：
    // `export { DEFAULT_WATER_GOAL_ML } from '@qsh/core';` 里没有 `=`，上面那条正则也不会命中它。
    expect(
      definitions,
      [
        'DEFAULT_WATER_GOAL_ML 出现了第二处常量定义 —— 默认饮水目标不再只有一个作者。',
        `唯一允许的定义位置是 ${CANONICAL_DEFINITION}；其余位置请改成从 '@qsh/core' re-export/import。`,
        '后果：改口径时漏掉一份，同一用户同一天会在不同屏看到不同的「今日目标」。',
      ].join('\n'),
    ).toEqual([CANONICAL_DEFINITION]);
  });
});
