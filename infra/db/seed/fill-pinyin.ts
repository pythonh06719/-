/**
 * 独立 CLI：补全 `food_items.seed.json` 的 `namePinyin`（**修复已存在种子**用）。
 *
 * ⚠️ 与 `merge-seeds.ts` 的关系（避免两个入口各说各话）：
 * **拼音生成的唯一真源是 `pinyin.ts`**；`merge-seeds.ts` 在每次写出种子前会**自动**调用
 * `fillPinyin(items)`，所以**正常情况下无需再单独跑本脚本**。本脚本仅用于：
 * - 合并流程之外、想单独给一份既有种子补拼音（例如手工修过 seed.json 后）；
 * - 排查/预览将补哪些拼音（默认试运行，不落盘）。
 *
 * 依赖：`pinyin-pro`（仓库根 devDependency）。
 * 运行（与仓库其他 seed 脚本一致，用 tsx 运行 TS）：
 *   npx tsx infra/db/seed/fill-pinyin.ts           # 试运行（打印将写入的拼音，不落盘）
 *   npx tsx infra/db/seed/fill-pinyin.ts --write    # 写回
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fillPinyin } from './pinyin';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(here, 'food_items.seed.json');
const WRITE = process.argv.includes('--write');

interface SeedFile {
  _meta?: Record<string, unknown>;
  items: Array<{ name: string; namePinyin?: string | null; [key: string]: unknown }>;
}

const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as SeedFile;

// 试运行时不改动原对象：先算出「将补」清单（对副本执行），确认后再落盘。
const filledNames: Array<{ name: string; pinyin: string }> = [];
let result: ReturnType<typeof fillPinyin>;
if (WRITE) {
  result = fillPinyin(seed.items);
} else {
  const preview = seed.items.map((item) => ({ ...item }));
  const before = new Map(preview.map((item) => [item.name, item.namePinyin]));
  result = fillPinyin(preview);
  for (const item of preview) {
    if (before.get(item.name) !== item.namePinyin && typeof item.namePinyin === 'string') {
      filledNames.push({ name: item.name, pinyin: item.namePinyin });
    }
  }
}

console.log(
  `pinyin 覆盖：原有 ${result.kept} + 新补 ${result.filled} = ${result.kept + result.filled}/${seed.items.length}` +
    `（跳过 ${result.skipped.length}）`,
);
if (result.skipped.length > 0) {
  console.log(`跳过（无可判定的中文主体，保持 null）：\n  ${result.skipped.join('\n  ')}`);
}
if (!WRITE) {
  console.log('\n新补明细（name -> pinyin）：');
  for (const row of filledNames) {
    console.log(`  ${row.name} -> ${row.pinyin}`);
  }
  console.log('\n（试运行，未写文件；加 --write 生效）');
  process.exit(0);
}

// 与既有种子排版保持一致（2 空格缩进）
writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2));
console.log(`\n已写回：${SEED_PATH}`);
