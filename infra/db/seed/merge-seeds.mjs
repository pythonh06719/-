/**
 * 种子合并脚本：把「本地样例集 + Open Food Facts + USDA 精选」三源合并为最终种子文件。
 *
 * - 本地样例（57 条，source='local' → 库内 'builtin'）：权威口径的常识值
 * - OFF（source='openfoodfacts'，ODbL 1.0）：中国区/港台区包装食品，署名要求见 README
 * - USDA（source='usda'，public domain）：SR Legacy 精选条目，中文名来自人工翻译映射
 *
 * 幂等：按名称跨源去重（本地样例优先级最高）。
 * 运行：node infra/db/seed/merge-seeds.mjs
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(here, 'food_items.seed.json');
const OFF_PATH = resolve(here, 'food_items.openfoodfacts.raw.json');
const USDA_PATH = resolve(here, 'food_items.usda.candidates.json');
const USDA_MAP_PATH = resolve(here, 'usda_zh_map.json');

// 备份当前种子（一次性）
try {
  copyFileSync(SEED_PATH, `${SEED_PATH}.bak`);
} catch {
  /* 首次运行无种子文件 */
}

const existing = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
const off = JSON.parse(readFileSync(OFF_PATH, 'utf8'));
const usda = JSON.parse(readFileSync(USDA_PATH, 'utf8'));
const zhMap = JSON.parse(readFileSync(USDA_MAP_PATH, 'utf8'));

const usdaByNdb = new Map(usda.items.map((item) => [String(item.ndbNumber), item]));
const seen = new Set(existing.items.map((item) => item.name));

const offItems = [];
for (const item of off.items) {
  if (seen.has(item.name)) continue;
  seen.add(item.name);
  offItems.push({
    name: item.name,
    namePinyin: item.namePinyin ?? null,
    aliases: item.aliases ?? [],
    category: item.category,
    kcalPer100g: item.kcalPer100g,
    protein: item.protein,
    fat: item.fat,
    carbs: item.carbs,
    fiber: item.fiber ?? null,
    sodium: item.sodium ?? null,
    sugar: item.sugar ?? null,
    servingUnits: item.servingUnits,
    source: 'openfoodfacts',
    isCustom: false,
    offCode: item.offCode,
  });
}

const usdaItems = [];
const skippedNoMap = [];
for (const pick of zhMap.picks) {
  const raw = usdaByNdb.get(String(pick.ndb));
  if (!raw) {
    skippedNoMap.push(pick.ndb);
    continue;
  }
  const name = pick.zh;
  if (seen.has(name)) continue;
  seen.add(name);
  usdaItems.push({
    name,
    namePinyin: null,
    aliases: [raw.category.split(',')[0] ?? 'usda'],
    category: pick.category,
    kcalPer100g: raw.kcalPer100g,
    protein: raw.protein,
    fat: raw.fat,
    carbs: raw.carbs,
    fiber: raw.fiber,
    sodium: raw.sodium,
    sugar: raw.sugar,
    saturatedFat: raw.saturatedFat ?? null,
    servingUnits: [{ unit: '100克', grams: 100, isDefault: true }],
    source: 'usda',
    isCustom: false,
    usdaNdb: String(raw.ndbNumber),
  });
}

const merged = {
  _meta: {
    description: '「轻生活」食物库种子：本地合规样例集 + Open Food Facts + USDA SR Legacy 精选',
    dataSource:
      '① 本地样例集：常识级公开营养值（57 条，权威口径）；' +
      '② Open Food Facts：开放许可 ODbL 1.0，© Open Food Facts contributors，采集区域为中国大陆/中国香港/中国台湾地区包装食品；' +
      '③ USDA FoodData Central SR Legacy：美国农业部公有领域数据，中文名为人工翻译，来源已逐条标注',
    precision:
      '全部为每 100g 数值；样例集取常识中位值，OFF/USDA 为原始测定/申报值（保留 1 位小数）。' +
      '数据用于日常记录参考，不构成营养诊断',
    sources: {
      local: { count: existing.items.length, license: '自建常识样例' },
      openfoodfacts: {
        count: offItems.length,
        license: 'ODbL 1.0（需署名并同许可共享）',
        url: 'https://world.openfoodfacts.org',
      },
      usda: {
        count: usdaItems.length,
        license: 'Public Domain（USDA FoodData Central SR Legacy）',
        url: 'https://fdc.nal.usda.gov',
      },
    },
    todo: existing._meta?.todo ?? '扩量至 500 条以上需客户提供授权数据集，严禁编造营养数值',
    itemCount: existing.items.length + offItems.length + usdaItems.length,
  },
  items: [...existing.items, ...offItems, ...usdaItems],
};

writeFileSync(SEED_PATH, JSON.stringify(merged, null, 2));
console.log(
  `合并完成：本地 ${existing.items.length} + OFF ${offItems.length} + USDA ${usdaItems.length}` +
    ` = ${merged.items.length} 条`,
);
if (skippedNoMap.length > 0) {
  console.log(`（${skippedNoMap.length} 个 ndb 在候选中未找到，已跳过：${skippedNoMap.join(',')}）`);
}
