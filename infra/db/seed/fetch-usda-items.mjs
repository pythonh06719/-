/**
 * USDA FoodData Central（SR Legacy）采集脚本（一次性工具）。
 *
 * 数据源：USDA FDC API（美国公有大宝（public domain），无版权限制；SR Legacy 为通用食物，无品牌）。
 * 目标：按中式饮食相关的关键词分组检索，筛出营养齐全的条目，
 *       输出候选文件供人工挑选并翻译中文名后并入种子。
 *
 * DEMO_KEY 限流：30 次/时（本脚本控制在 ≤22 次请求）。
 * 运行：node infra/db/seed/fetch-usda-items.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(here, 'food_items.usda.candidates.json');

const API_KEY = 'DEMO_KEY';
const PAGE_SIZE = 200;
const DELAY_MS = 4000;

/** 中式饮食相关检索词（宽泛词，一次拉 200 条，靠分类过滤噪音）。 */
const QUERIES = [
  'rice', 'noodles', 'tofu', 'soymilk', 'soybean', 'mung', 'seaweed', 'bamboo',
  'mushroom', 'chinese', 'radish', 'sweet potato', 'taro', 'water chestnut',
  'lychee', 'persimmon', 'jujube', 'pomelo', 'longan', 'sesame', 'peanut', 'tea',
];

/** 允许的 SR Legacy 分类（排除 Fast Foods / Restaurant / Baby / Sausages 等美式噪音）。 */
const CATEGORY_ALLOW = [
  'Cereals, Grains, and Pasta',
  'Vegetables and Vegetable Products',
  'Fruits and Fruit Juices',
  'Legumes and Legume Products',
  'Nut and Seed Products',
  'Finfish and Shellfish Products',
  'Poultry Products',
  'Pork Products',
  'Beef Products',
  'Lamb, Veal, and Game Products',
  'Dairy and Egg Products',
  'Fats and Oils',
  'Spices and Herbs',
  'Snacks',
  'Baked Products',
  'Soups, Sauces, and Gravies',
  'Beverages',
];

/** 按 nutrientId 取值。 */
function pick(nutrients, id) {
  const found = nutrients.find((n) => n.nutrientId === id);
  const value = found?.value;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function mapItem(food) {
  const category = food.foodCategory ?? '';
  if (!CATEGORY_ALLOW.includes(category)) return null;

  const description = String(food.description ?? '').trim();
  if (description.length < 4) return null;
  // 排除明显的美式餐食描述
  if (/fast food|restaurant|bab(y|ies)|school lunch|military|nachos|burrito|taco|pizza|burger/i.test(description)) {
    return null;
  }

  const n = food.foodNutrients ?? [];
  const kcal = pick(n, 1008);
  const protein = pick(n, 1003);
  const fat = pick(n, 1004);
  const carbs = pick(n, 1005);
  if (kcal === null || kcal <= 0 || kcal > 900) return null;
  if (![protein, fat, carbs].every((v) => v !== null && v >= 0)) return null;

  return {
    ndbNumber: food.ndbNumber,
    fdcId: food.fdcId,
    description,
    category,
    kcalPer100g: Math.round(kcal * 10) / 10,
    protein: Math.round(protein * 10) / 10,
    fat: Math.round(fat * 10) / 10,
    carbs: Math.round(carbs * 10) / 10,
    fiber: pick(n, 1079),
    sugar: pick(n, 2000),
    sodium: pick(n, 1093) === null ? null : Math.round(pick(n, 1093)),
    saturatedFat: pick(n, 1258),
    source: 'usda',
  };
}

const byNdb = new Map();
const categoryDigest = new Map();
let requests = 0;

for (const query of QUERIES) {
  if (requests >= 22) {
    console.log(`已用满 ${requests} 次请求配额，停止`);
    break;
  }
  const url =
    `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${API_KEY}` +
    `&query=${encodeURIComponent(query)}&dataType=SR+Legacy` +
    `&pageSize=${PAGE_SIZE}&pageNumber=1`;
  let body = null;
  for (let attempt = 1; attempt <= 3 && !body; attempt += 1) {
    requests += 1;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (response.status === 429) {
        console.error(`[${query}] 429 限流，等待 70s…`);
        await new Promise((r) => setTimeout(r, 70000));
        continue;
      }
      if (!response.ok) {
        console.error(`[${query}] HTTP ${response.status}`);
        break;
      }
      body = await response.json();
    } catch (error) {
      console.error(`[${query}] 网络异常：${error.message}`);
      await new Promise((r) => setTimeout(r, 8000));
    }
  }
  if (!body) continue;

  let added = 0;
  for (const food of body.foods ?? []) {
    const mapped = mapItem(food);
    if (!mapped || byNdb.has(mapped.ndbNumber)) continue;
    byNdb.set(mapped.ndbNumber, mapped);
    categoryDigest.set(mapped.category, (categoryDigest.get(mapped.category) ?? 0) + 1);
    added += 1;
  }
  console.log(`[${query}] +${added}（累计 ${byNdb.size}，totalHits=${body.totalHits ?? '?'}, pages=${body.totalPages ?? '?'})`);
  await new Promise((r) => setTimeout(r, DELAY_MS));
}

const items = [...byNdb.values()];
writeFileSync(OUTPUT_PATH, JSON.stringify({ collected: items.length, items }, null, 1));
console.log(`\n分类分布：`);
for (const [category, count] of [...categoryDigest.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count.toString().padStart(4)}  ${category}`);
}
console.log(`\n完成：候选 ${items.length} 条 → ${OUTPUT_PATH}`);
