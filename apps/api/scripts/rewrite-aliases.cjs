#!/usr/bin/env node
/**
 * 构建后处理：把 `tsc` 产物中的 workspace 别名 `require("@qsh/*")` 改写为**相对路径**。
 *
 * 背景（T03 偏离记录）：
 *   `@qsh/core` / `@qsh/shared-types` 通过 tsconfig `paths` 以**源码**（`.ts`）形式被引用，
 *   而 `tsc` **不会重写**路径别名 —— 编译产物里仍保留 `require("@qsh/core")`。
 *   Node 运行时分派到 `node_modules/@qsh/core → packages/core`，其 `main` 指向 `./src/index.ts`，
 *   原生 Node **无法加载 .ts**，导致 `node dist/.../main.js` 崩溃。
 *
 * 方案：`tsc` 已顺带把 `packages/core/src`（纯函数、零运行时依赖）编译进 `dist/packages/core/src`。
 *   本脚本把每个产物文件里的 `require("@qsh/<name>")` 改写为指向 `dist/packages/<name>/src/index.js`
 *   的相对路径，使 `dist` 成为**自包含**的 CommonJS 产物 —— 既供 `start:prod` 使用，
 *   也供 vitest 端到端测试直接 `require`（保证与服务端完全同一份、且带装饰器元数据的代码）。
 *
 * 纯 Node 标准库实现，不依赖任何第三方包，可重复执行（幂等：已改写为相对路径的 require 不再匹配）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIST_ROOT = path.resolve(__dirname, '..', 'dist');
const APP_SRC_ROOT = path.join(DIST_ROOT, 'apps');
const PKG_SCOPE = '@qsh/';
const REQUIRE_RE = /require\(\s*(['"])(@qsh\/[^'"]+)\1\s*\)/g;

/**
 * 递归收集目录下所有 `.js` 文件（跳过 `node_modules`）。
 * @param {string} dir 目录绝对路径
 * @returns {string[]} 文件绝对路径数组
 */
function collectJsFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectJsFiles(full));
    } else if (entry.isFile() && full.endsWith('.js')) {
      result.push(full);
    }
  }
  return result;
}

/**
 * 改写单个产物文件中的 `@qsh/*` require 为相对路径。
 * @param {string} file 文件绝对路径
 * @returns {boolean} 是否发生改写
 */
function rewriteFile(file) {
  const original = fs.readFileSync(file, 'utf8');
  const fileDir = path.dirname(file);
  let changed = false;

  const next = original.replace(REQUIRE_RE, (match, quote, specifier) => {
    const pkgName = specifier.slice(PKG_SCOPE.length);
    const target = path.join(DIST_ROOT, 'packages', pkgName, 'src', 'index.js');
    if (!fs.existsSync(target)) {
      // 该包未产出运行时代码（例如纯类型包 @qsh/shared-types，引用已在编译期擦除）——保持原样。
      return match;
    }
    let relative = path.relative(fileDir, target).split(path.sep).join('/');
    if (!relative.startsWith('.')) {
      relative = `./${relative}`;
    }
    changed = true;
    return `require(${quote}${relative}${quote})`;
  });

  if (changed) {
    fs.writeFileSync(file, next, 'utf8');
  }
  return changed;
}

/** 入口。 */
function main() {
  if (!fs.existsSync(APP_SRC_ROOT)) {
    console.error('[rewrite-aliases] 未找到构建产物目录：', APP_SRC_ROOT);
    console.error('[rewrite-aliases] 请先执行 `nest build`。');
    process.exit(1);
  }

  const files = collectJsFiles(APP_SRC_ROOT);
  let count = 0;
  for (const file of files) {
    if (rewriteFile(file)) {
      count += 1;
    }
  }
  console.log(`[rewrite-aliases] 完成：扫描 ${files.length} 个文件，改写 ${count} 个 @qsh/* 引用为相对路径。`);
}

main();
