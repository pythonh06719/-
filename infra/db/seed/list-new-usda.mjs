/**
 * 打印「尚未翻译」的 USDA 候选条目（供人工挑选 + 翻译）。
 * 用法：node infra/db/seed/list-new-usda.mjs [分类关键词] [每页条数]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const candidates = JSON.parse(readFileSync(resolve(here, 'food_items.usda.candidates.json'), 'utf8'));
const zhMap = JSON.parse(readFileSync(resolve(here, 'usda_zh_map.json'), 'utf8'));
const taken = new Set(zhMap.picks.map((p) => String(p.ndb)));

const keyword = (process.argv[2] ?? '').toLowerCase();
const limit = Number(process.argv[3] ?? 400);

const fresh = candidates.items.filter((item) => !taken.has(String(item.ndbNumber)));
const filtered = keyword
  ? fresh.filter((i) => `${i.description} ${i.category}`.toLowerCase().includes(keyword))
  : fresh;

console.log(`未翻译候选 ${fresh.length} 条${keyword ? `（含「${keyword}」的 ${filtered.length} 条）` : ''}`);
for (const [index, item] of filtered.slice(0, limit).entries()) {
  console.log(
    `${String(index + 1).padStart(3)} ${String(item.ndbNumber).padStart(6)} | ${item.category.slice(0, 12).padEnd(12)} | ${item.description.slice(0, 74)} | ${item.kcalPer100g}`,
  );
}
