/**
 * Open Food Facts 数据采集脚本（一次性工具）。
 *
 * 数据源：Open Food Facts 官方 API v2（开放许可 ODbL 1.0，需署名）。
 * 目标：拉取中国区、中文名、四大宏量营养素齐全的条目，转换为
 *       `infra/db/seed/food_items.seed.json` 的 items 格式（source='openfoodfacts'）。
 *
 * 质量门槛：
 * - energy-kcal_100g / proteins_100g / fat_100g / carbohydrates_100g 全部存在且 >0 合理
 * - 名称 ≥2 字符、非纯数字；每 100g 热量 ≤ 900（纯油脂上限）
 * - 与既有 57 条种子按名称去重、内部按名称去重
 *
 * 运行：node infra/db/seed/fetch-off-items.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(here, 'food_items.seed.json');
const OUTPUT_PATH = resolve(here, 'food_items.openfoodfacts.raw.json');

const UA = 'qingshenghuo-app/1.0 (nutrition seed builder; contact: dev@qingshenghuo.local)';
const TARGET = 600; // 采集上限（宁多勿少，入库前还会过质量关）
const PAGE_SIZE = 100; // OFF v2 search API 单页实际上限 100
const MAX_RETRY = 6;
/** 采集区域：中国大陆 + 中国香港 + 中国台湾（OFF 的地区标签，均为中文商品数据） */
const REGIONS = (process.env.OFF_REGIONS ?? 'china,hong-kong,taiwan').split(',');
/** 请求间隔：OFF 深页需慢速（约 1 请求/分钟），快速模式 2s 只够浅页 */
const DELAY_MS = Number(process.env.OFF_DELAY_MS ?? 2000);
/** 每个区域从第几页开始（配合去重可断点续采），如 OFF_START='china:6,hong-kong:1,taiwan:2' */
const startMap = new Map(
  (process.env.OFF_START ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split(':'))
    .map(([region, page]) => [region.trim(), Number(page) || 1]),
);

/** 把 OFF 的 nutriments 映射为种子字段；宏量不齐返回 null。 */
function mapItem(product) {
  const name = String(product.product_name ?? '').trim();
  if (name.length < 2 || name.length > 60 || /^\d+$/.test(name)) return null;
  if (!/[\u4e00-\u9fff]/.test(name)) return null; // 只收中文名

  const n = product.nutriments ?? {};
  const kcal = Number(n['energy-kcal_100g']);
  const protein = Number(n['proteins_100g']);
  const fat = Number(n['fat_100g']);
  const carbs = Number(n['carbohydrates_100g']);
  if (![kcal, protein, fat, carbs].every((v) => Number.isFinite(v) && v >= 0)) return null;
  if (kcal <= 0 || kcal > 900) return null;
  // 宏量守恒粗检（75% 宽容度）：酒类等特殊供能不遵守 4/4/9，放宽以避免误杀合法条目
  const derived = protein * 4 + carbs * 4 + fat * 9;
  if (derived > 0 && Math.abs(derived - kcal) / Math.max(kcal, 1) > 0.75) return null;

  const fiber = Number(n['fiber_100g']);
  const sugars = Number(n['sugars_100g']);
  const satFat = Number(n['saturated-fat_100g']);
  const sodiumMg = Number.isFinite(Number(n['sodium_100g']))
    ? Number(n['sodium_100g']) * 1000
    : Number.isFinite(Number(n['salt_100g']))
      ? Number(n['salt_100g']) * 400
      : NaN;

  const servingQuantity = Number(product.serving_quantity);
  const servingUnits = [];
  if (Number.isFinite(servingQuantity) && servingQuantity >= 5 && servingQuantity <= 1000) {
    servingUnits.push({ unit: '份', grams: Math.round(servingQuantity), isDefault: true });
  }
  servingUnits.push({ unit: '100克', grams: 100, isDefault: servingUnits.length === 0 });

  const brands = String(product.brands ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const categories = Array.isArray(product.categories_tags) ? product.categories_tags : [];
  const categoryTag = categories.find((tag) => tag.startsWith('zh:')) ?? categories[0] ?? '';
  const category = categoryTag
    ? decodeURIComponent(categoryTag.replace(/^..:/, '')).split('-')[0].slice(0, 20)
    : '包装食品';

  return {
    name,
    namePinyin: null,
    aliases: brands.slice(0, 2),
    category: category || '包装食品',
    kcalPer100g: Math.round(kcal * 10) / 10,
    protein: Math.round(protein * 10) / 10,
    fat: Math.round(fat * 10) / 10,
    carbs: Math.round(carbs * 10) / 10,
    fiber: Number.isFinite(fiber) ? Math.round(fiber * 10) / 10 : null,
    sodium: Number.isFinite(sodiumMg) ? Math.round(sodiumMg) : null,
    sugar: Number.isFinite(sugars) ? Math.round(sugars * 10) / 10 : null,
    saturatedFat: Number.isFinite(satFat) ? Math.round(satFat * 10) / 10 : null,
    servingUnits,
    source: 'openfoodfacts',
    isCustom: false,
    offCode: product.code,
  };
}

const seen = new Set();
const collected = [];

/** 带退避重试的抓取（OFF 服务器偶发 503）。 */
async function fetchWithRetry(url) {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(45000),
      });
      if (response.ok) return response.json();
      console.error(`  HTTP ${response.status}（第 ${attempt} 次）`);
    } catch (error) {
      console.error(`  网络异常（第 ${attempt} 次）：${error.message}`);
    }
    if (attempt < MAX_RETRY) {
      const waitMs = Math.min(45000, 5000 * attempt);
      console.error(`  等待 ${waitMs / 1000}s 后重试…`);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, waitMs));
    }
  }
  return null;
}

let totalCount = -1;
for (const region of REGIONS) {
  if (collected.length >= TARGET) break;
  const startPage = startMap.get(region.trim()) ?? 1;
  for (let page = startPage; page <= startPage + 19 && collected.length < TARGET; page += 1) {
    const url =
      `https://world.openfoodfacts.org/api/v2/search?countries_tags=${region}` +
      `&fields=code,product_name,brands,categories_tags,nutriments,serving_quantity` +
      `&page_size=${PAGE_SIZE}&page=${page}`;
    const body = await fetchWithRetry(url);
    if (!body) {
      console.error(`${region} page ${page}: 放弃（重试耗尽）`);
      break;
    }
    if (totalCount === -1 && Number.isFinite(body.count)) {
      totalCount = body.count;
      console.log(`首个区域符合条件总条数（服务器侧）：${totalCount}`);
    }
    const products = body.products ?? [];
    let addedThisPage = 0;
    for (const product of products) {
      if (collected.length >= TARGET) break;
      const mapped = mapItem(product);
      if (!mapped || seen.has(mapped.name)) continue;
      seen.add(mapped.name);
      collected.push(mapped);
      addedThisPage += 1;
    }
    console.log(`[${region}] page ${page}: +${addedThisPage}（累计 ${collected.length}/${TARGET}）`);
    if (products.length < PAGE_SIZE) break; // 该区域翻完
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 2000));
  }
}

// 与既有种子去重（按名称），并**追加**到既有原始文件（累加，避免后续运行覆盖丢数据）
const existing = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
const existingNames = new Set(existing.items.map((item) => item.name));
let previousRaw = [];
try {
  const rawPrevious = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
  previousRaw = Array.isArray(rawPrevious.items) ? rawPrevious.items : [];
} catch {
  previousRaw = []; // 首次运行无既有原始文件
}
const mergedByName = new Map(previousRaw.map((item) => [item.name, item]));
for (const item of collected) mergedByName.set(item.name, item);
const fresh = [...mergedByName.values()].filter((item) => !existingNames.has(item.name));

writeFileSync(
  OUTPUT_PATH,
  JSON.stringify(
    {
      _meta: {
        description: 'Open Food Facts 中国区条目（原始采集，入库前请人工抽检；多次采集累加）',
        license: 'Open Database License (ODbL) 1.0 — © Open Food Facts contributors',
        attribution: '数据来源 Open Food Facts (https://world.openfoodfacts.org)，ODbL 1.0 许可，使用需署名并同许可共享',
        fetchedAt: new Date().toISOString(),
        collectedThisRun: collected.length,
        accumulatedTotal: mergedByName.size,
        freshAfterDedupe: fresh.length,
      },
      items: fresh,
    },
    null,
    2,
  ),
);
console.log(
  `完成：本次采集 ${collected.length} 条，累计原始池 ${mergedByName.size} 条，与既有种子去重后 ${fresh.length} 条 → ${OUTPUT_PATH}`,
);
