/**
 * 食物库「数据质量」一次性修复脚本（T2 分类归一 + T4 来源计数）。
 *
 * 背景：`food_items.seed.json` 现有 443 条，`category` 出现 **59 种**取值，
 * 而 schema 只承认 9 类（见 `apps/api/prisma/schema.prisma`）。本脚本用
 * `@qsh/core` 的**唯一口径**（`mapFoodCategory`）就地重写：
 *   1. `food_items.seed.json` 每条 `items[].category`；
 *   2. `usda_zh_map.json` 每个 `picks[].category`（否则重跑 `merge-seeds` 会退回脏值）；
 *   3. `food_items.openfoodfacts.raw.json` 每条 `items[].category`（同上）；
 *   4. `food_items.seed.json` 的 `_meta.sources[].count` / `_meta.itemCount`
 *      —— 改为**按 items 真实统计**（旧值 `local 367 / off 76 / usda 0` 是拿
 *      「合并前条数」当 local 数，纯造假）。
 *
 * **不新增 / 不删除任何食物条目，也不改其它字段。**
 *
 * 运行：
 *   npx tsx infra/db/seed/fix-data-quality.ts           # 试运行（只打印报告，不写文件）
 *   npx tsx infra/db/seed/fix-data-quality.ts --write    # 写回文件
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FOOD_CATEGORIES, isFoodCategory, mapFoodCategory } from '@qsh/core';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(here, 'food_items.seed.json');
const USDA_MAP_PATH = resolve(here, 'usda_zh_map.json');
const OFF_RAW_PATH = resolve(here, 'food_items.openfoodfacts.raw.json');

const WRITE = process.argv.includes('--write');

/** 极简结构类型（只声明本脚本读写的字段）。 */
interface SeedItem {
  name: string;
  category: string;
  source?: string;
  [key: string]: unknown;
}
interface SeedFile {
  _meta: Record<string, unknown> & { sources?: Record<string, { count?: number }>; itemCount?: number };
  items: SeedItem[];
}

/** 统计一组值 → 频次（降序）。 */
function distribution(values: string[]): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const value of values) {
    map.set(value, (map.get(value) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/** 断言分类合法（内联自检；不合法即抛错，绝不静默写脏值）。 */
function assertCategory(category: string, where: string): void {
  if (!isFoodCategory(category)) {
    throw new Error(`${where} 分类非法：${JSON.stringify(category)}（应为 ${FOOD_CATEGORIES.join('/')} 之一）`);
  }
}

// ---------------------------------------------------------------------------
// 1. 种子主文件
// ---------------------------------------------------------------------------
const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as SeedFile;
const beforeCats = distribution(seed.items.map((item) => item.category));
const originalCategory = new Map<string, string>(seed.items.map((item) => [item.name, item.category]));

const changed: Array<{ name: string; from: string; to: string }> = [];
for (const item of seed.items) {
  const next = mapFoodCategory(item.category, item.name);
  assertCategory(next, `种子「${item.name}」`);
  if (next !== item.category) {
    changed.push({ name: item.name, from: item.category, to: next });
    item.category = next;
  }
}

const afterCats = distribution(seed.items.map((item) => item.category));
const illegalAfter = seed.items.filter((item) => !isFoodCategory(item.category));
if (illegalAfter.length > 0) {
  throw new Error(`修复后仍有 ${illegalAfter.length} 条非法分类`);
}

// ---------------------------------------------------------------------------
// 2. USDA 中文映射（picks[].category）
// ---------------------------------------------------------------------------
const usdaMap = JSON.parse(readFileSync(USDA_MAP_PATH, 'utf8')) as {
  picks: Array<{ ndb: number; zh: string; category: string }>;
};
let usdaChanged = 0;
for (const pick of usdaMap.picks) {
  const next = mapFoodCategory(pick.category, pick.zh);
  assertCategory(next, `USDA「${pick.zh}」`);
  if (next !== pick.category) {
    pick.category = next;
    usdaChanged += 1;
  }
}

// ---------------------------------------------------------------------------
// 3. OFF 原始采集（items[].category）
// ---------------------------------------------------------------------------
const offRaw = JSON.parse(readFileSync(OFF_RAW_PATH, 'utf8')) as { items: SeedItem[] };
let offChanged = 0;
for (const item of offRaw.items) {
  const next = mapFoodCategory(item.category, item.name);
  assertCategory(next, `OFF「${item.name}」`);
  if (next !== item.category) {
    item.category = next;
    offChanged += 1;
  }
}

// ---------------------------------------------------------------------------
// 4. _meta.sources 按真实项重算
// ---------------------------------------------------------------------------
const bySource = distribution(seed.items.map((item) => String(item.source ?? '')));
const sourceCount = new Map(bySource);
const meta = seed._meta;
meta.itemCount = seed.items.length;
if (meta.sources !== undefined) {
  for (const [key, entry] of Object.entries(meta.sources)) {
    const real = sourceCount.get(key) ?? 0;
    entry.count = real;
  }
}

// ---------------------------------------------------------------------------
// 5. 报告
// ---------------------------------------------------------------------------
console.log(`[种子] 共 ${seed.items.length} 条，来源分布：${JSON.stringify(bySource)}`);
console.log(`[分类] 修复前 ${beforeCats.length} 种 → 修复后 ${afterCats.length} 种`);
console.log(`[分类] 修复后分布：${JSON.stringify(afterCats)}`);
console.log(`[分类] 种子改动 ${changed.length} 条；USDA 映射改动 ${usdaChanged} 条；OFF 原始改动 ${offChanged} 条`);
console.log(`[_meta.sources] 重算：${JSON.stringify(meta.sources)}`);

const NON_OTHER = changeSummary(changed, 'other');
if (NON_OTHER.length > 0) {
  console.log(`[复核] 由合法值被改走的条目（应为 0，如有请人工确认）：`);
  for (const row of NON_OTHER) {
    console.log(`   - ${row.name}：${row.from} → ${row.to}`);
  }
}
const toOther = changed.filter((c) => c.to === 'other');
if (toOther.length > 0) {
  console.log(`[复核] 归入 other 的 ${toOther.length} 条（原值 → other）：`);
  for (const row of toOther) {
    console.log(`   - ${row.name}（原 ${row.from}）`);
  }
}

// 详细审计：按「新分类」分组列出全部条目（含原值），用于人工核对。
if (process.argv.includes('--verbose')) {
  const groups = new Map<string, Array<{ name: string; from: string }>>();
  for (const item of seed.items) {
    const list = groups.get(item.category) ?? [];
    list.push({ name: item.name, from: originalCategory.get(item.name) ?? item.category });
    groups.set(item.category, list);
  }
  for (const category of FOOD_CATEGORIES) {
    const list = groups.get(category) ?? [];
    console.log(`\n===== ${category}（${list.length}）=====`);
    console.log(list.map((row) => (row.from === category ? row.name : `${row.name}[${row.from}]`)).join(' | '));
  }
}

if (!WRITE) {
  console.log('\n（试运行，未写文件；加 --write 生效）');
  process.exit(0);
}

// 保持各文件原有排版（seed / OFF 无行尾换行；usda 保持「每个 pick 一行」的紧凑风格），
// 让 diff 只体现语义变化（分类 + 计数），不产生格式化噪声。
writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2));
writeFileSync(OFF_RAW_PATH, JSON.stringify(offRaw, null, 2));
writeFileSync(USDA_MAP_PATH, serializeUsdaMap(usdaMap));
console.log(`\n已写回：${SEED_PATH}\n已写回：${USDA_MAP_PATH}\n已写回：${OFF_RAW_PATH}`);

/**
 * 序列化 `usda_zh_map.json`：保留顶层键顺序，`picks` 每个元素**压缩为一行**
 * （与仓库既有排版一致，避免重排产生数千行 diff）。
 */
function serializeUsdaMap(map: {
  picks: Array<Record<string, unknown>>;
  [key: string]: unknown;
}): string {
  const compact = (obj: Record<string, unknown>): string =>
    `{ ${Object.entries(obj)
      .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join(', ')} }`;
  const head = Object.entries(map)
    .filter(([key]) => key !== 'picks')
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{\n${head.join(',\n')},\n  "picks": [\n${map.picks
    .map((pick) => `    ${compact(pick)}`)
    .join(',\n')}\n  ]\n}\n`;
}

/** 过滤出「起点本身合法、却被改成其它类」的异常改动（用于人工复核）。 */
function changeSummary(rows: Array<{ name: string; from: string; to: string }>, _tag: string) {
  return rows.filter((row) => isFoodCategory(row.from) && row.from !== row.to);
}
