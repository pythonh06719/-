/**
 * USDA 采集 · 第二轮（DEMO_KEY 时限窗口重置后自动运行）。
 *
 * 与第一轮同款映射逻辑；结果**合并**进 food_items.usda.candidates.json（按 ndbNumber 去重）。
 * 运行：node infra/db/seed/fetch-usda-round2.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CANDIDATES_PATH = resolve(here, 'food_items.usda.candidates.json');

const API_KEY = 'DEMO_KEY';
const PAGE_SIZE = 200;
const DELAY_MS = 4500;
const QUERIES = [
  'chinese', 'radish', 'sweet potato', 'taro', 'water chestnut',
  'lychee', 'persimmon', 'jujube', 'pomelo', 'longan',
  'sesame', 'peanut', 'tea',
];

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

// 等待 DEMO_KEY 小时窗口重置：默认跳过（新一天窗口已重置）；需要等待时设 WAIT_FOR_WINDOW=1
if (process.env.WAIT_FOR_WINDOW === '1') {
  console.log('等待 42 分钟让 DEMO_KEY 限流窗口重置…');
  await new Promise((resolveWait) => setTimeout(resolveWait, 42 * 60 * 1000));
}

const existing = existsSync(CANDIDATES_PATH)
  ? JSON.parse(readFileSync(CANDIDATES_PATH, 'utf8'))
  : { collected: 0, items: [] };
const byNdb = new Map(existing.items.map((item) => [String(item.ndbNumber), item]));

let requests = 0;
let added = 0;
for (const query of QUERIES) {
  if (requests >= 14) {
    console.log(`本窗口配额用满（${requests} 次），停止`);
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
        console.error(`[${query}] 429，等待 75s 重试（第 ${attempt} 次）`);
        await new Promise((r) => setTimeout(r, 75000));
        continue;
      }
      if (!response.ok) {
        console.error(`[${query}] HTTP ${response.status}`);
        break;
      }
      body = await response.json();
    } catch (error) {
      console.error(`[${query}] 网络异常：${error.message}`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  if (!body) continue;

  let addedThisQuery = 0;
  for (const food of body.foods ?? []) {
    const mapped = mapItem(food);
    if (!mapped || byNdb.has(String(mapped.ndbNumber))) continue;
    byNdb.set(String(mapped.ndbNumber), mapped);
    addedThisQuery += 1;
    added += 1;
  }
  console.log(`[${query}] +${addedThisQuery}（总库 ${byNdb.size}，totalHits=${body.totalHits ?? '?'})`);
  await new Promise((r) => setTimeout(r, DELAY_MS));
}

writeFileSync(
  CANDIDATES_PATH,
  JSON.stringify({ collected: byNdb.size, items: [...byNdb.values()] }, null, 1),
);
console.log(`\n第二轮完成：本轮新增 ${added}，候选总数 ${byNdb.size}`);
