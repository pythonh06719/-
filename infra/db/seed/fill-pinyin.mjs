/**
 * 补全 `food_items.seed.json` 的 `namePinyin`（「食物库数据质量」T3）。
 *
 * 背景：`namePinyin` 是拼音搜索字段（`schema.prisma` 有 `ix_food_pinyin` 索引），
 * 但 443 条里只有 57 条（本地样例，人工填写）有值，覆盖率仅 12.9%。本脚本用
 * **`pinyin-pro`**（纯 JS、无网络依赖、含多音字词典）为缺失条目补齐。
 *
 * 与既有 57 条**保持同一约定**（先看样例总结而来）：
 * - 取「食物名去掉括号限定词」后的主体（如「米饭（白，蒸）」→「米饭」→ `mifan`）；
 * - 全小写、无音调、无分隔符；
 * - `ü` 写作 `v`（如「圣女果」→ `shengnvguo`）；
 * - 主体不含中文（纯日文/英文名，如「たけのこの里」）→ **留空（宁缺勿错）**。
 *
 * 多音字准确性依赖 `pinyin-pro` 的词语词典（实测「重庆」→ chongqing、
 * 「干贝」→ ganbei、「猕猴桃」→ mihoutao 均正确）。
 *
 * 依赖：`pinyin-pro`（仓库根 devDependency）。
 * 运行：
 *   node infra/db/seed/fill-pinyin.mjs           # 试运行（打印将写入的拼音，不落盘）
 *   node infra/db/seed/fill-pinyin.mjs --write    # 写回
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pinyin } from 'pinyin-pro';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(here, 'food_items.seed.json');
const WRITE = process.argv.includes('--write');

const HAN = /[\u4e00-\u9fff]/;
/** 日文假名音节（平假名 / 片假名字母；**不含**中点「・」U+30FB 与长音符「ー」U+30FC，避免误判含「・」的中文名）。 */
const KANA = /[\u3041-\u3096\u30a1-\u30fa\u30fd-\u30ff]/;

/** 取括号限定词之前的主体（与既有样例约定一致）。 */
function baseName(name) {
  return name.split(/[（(]/)[0].trim();
}

/**
 * 生成拼音（无音调、小写、`ü`→`v`）；无法判定（名称含日文假名、或主体无中文）返回 `null`。
 * @param {string} name 食物名
 * @returns {string|null}
 */
function toPinyin(name) {
  if (KANA.test(name)) {
    return null; // 日文商品名（如「茎わかめ」「さばみそ煮」）→ 宁缺勿错
  }
  const base = baseName(name) || name.trim();
  if (!HAN.test(base)) {
    return null; // 纯英文/数字名 → 宁缺勿错
  }
  const parts = pinyin(base, { toneType: 'none', type: 'array', nonZh: 'removed' });
  const joined = parts
    .join('')
    .toLowerCase()
    .replace(/ü/g, 'v')
    .replace(/[^a-z]/g, '');
  return joined.length > 0 ? joined : null;
}

const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));

const kept = [];
const filled = [];
const skipped = [];
for (const item of seed.items) {
  if (typeof item.namePinyin === 'string' && item.namePinyin.trim() !== '') {
    kept.push(item);
    continue;
  }
  const py = toPinyin(item.name);
  if (py === null) {
    skipped.push(item.name);
    continue;
  }
  filled.push({ name: item.name, pinyin: py });
  if (WRITE) {
    item.namePinyin = py;
  }
}

console.log(
  `pinyin 覆盖：原有 ${kept.length} + 新补 ${filled.length} = ${kept.length + filled.length}/${seed.items.length}` +
    `（跳过 ${skipped.length}）`,
);
if (skipped.length > 0) {
  console.log(`跳过（无可判定的中文主体，保持 null）：\n  ${skipped.join('\n  ')}`);
}

console.log('\n新补明细（name -> pinyin）：');
for (const row of filled) {
  console.log(`  ${row.name} -> ${row.pinyin}`);
}

if (!WRITE) {
  console.log('\n（试运行，未写文件；加 --write 生效）');
  process.exit(0);
}

// 与既有种子排版保持一致（2 空格缩进，无行尾换行）
writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2));
console.log(`\n已写回：${SEED_PATH}`);
