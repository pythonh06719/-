/**
 * Open Food Facts 客户端 + 归一化（R3.6 / Phase C-1，在线食物库兜底）。
 *
 * 设计取舍：
 * - **零新依赖**：用 Node 原生 `fetch` 调 OFF 公开 REST 接口；
 * - **只读代理**：仅向 OFF 发送**搜索词**与**条码**，绝不携带 `userId` / token / 健康数据；
 * - **优雅降级**：网络异常 / 非 2xx / JSON 解析失败一律**不抛错**，返回 `degraded: true`，
 *   由上层包装为「先用本地结果」的友好提示（绝不 500）；
 * - **归一化到 FoodItem 形状**：字段名与 `@qsh/shared-types` 的 `FoodItem` 对齐，
 *   前端可复用同一套份量/热量换算逻辑；
 * - **过滤脏数据**：名称缺失、热量为 NaN / 负数 / 缺条码的条目一律计入 `skipped`，
 *   不做静默转换（与 agent 侧校验规则一致）。
 *
 * 许可：OFF 数据为 **ODbL 1.0**，须署名「© Open Food Facts contributors」（见 DATA-LICENSE.md）。
 */

import { round1 } from '@qsh/core';

import type { ServingUnit } from '@qsh/shared-types';

/** 归一化后的「外部食物草稿」——尚未入库，故无 DB `id`。 */
export interface ExternalFoodDraft {
  /** 外部唯一标识（OFF 的 `code`，即条码） */
  externalId: string;
  /** 名称（中文优先，回退原文） */
  name: string;
  /** 映射到本项目分类（主食 / 家常菜 / 外卖 / 奶茶 / 零食 / 水果 / 蔬菜 / 蛋白 / other） */
  category: string;
  kcalPer100g: number;
  proteinGPer100g: number;
  fatGPer100g: number;
  carbGPer100g: number;
  servingUnits: ServingUnit[];
  defaultServingGrams: number | null;
  /** 条码（与 `externalId` 相同，8–14 位数字） */
  barcode: string;
  /** 品牌（可空） */
  brand: string | null;
  /** 上游商品页（供用户核验 / ODbL 署名） */
  sourceUrl: string;
}

/** 搜索归一化结果。 */
export interface OffSearchOutcome {
  /** 归一化通过的条目 */
  drafts: ExternalFoodDraft[];
  /** 被过滤掉（脏数据）的条目数 */
  skipped: number;
  /** 是否降级（网络异常 / 上游不可用） */
  degraded: boolean;
}

/** 单品查询结果。 */
export interface OffProductOutcome {
  /** 命中则返回草稿，未命中为 `null` */
  draft: ExternalFoodDraft | null;
  /** 是否降级（网络异常 / 上游不可用） */
  degraded: boolean;
}

/** OFF 许可标识（展示与署名用）。 */
export const OFF_LICENSE = 'ODbL 1.0';

/** OFF 署名文案（ODbL 要求）。 */
export const OFF_ATTRIBUTION = '© Open Food Facts contributors';

/** 数据来源标识。 */
export const OFF_SOURCE = 'openfoodfacts' as const;

/** 上游超时（毫秒）——失败即降级，绝不挂起用户请求。 */
export const OFF_TIMEOUT_MS = 6_000;

/** 合法条码：8–14 位数字（EAN-8 / UPC-12 / EAN-13 / GTIN-14）。 */
export const BARCODE_PATTERN = /^\d{8,14}$/;

/** OFF 基址（可用环境变量覆盖，便于自建镜像 / 测试）。 */
function offBaseUrl(): string {
  const raw = process.env.OPENFOODFACTS_BASE_URL;
  const base = raw !== undefined && raw.trim() !== '' ? raw.trim() : 'https://world.openfoodfacts.org';
  return base.replace(/\/+$/, '');
}

/** OFF 要求的自定义 User-Agent（匿名、不含任何用户信息）。 */
export const OFF_USER_AGENT = 'qingshenghuo/0.1 (open-source weight-loss helper; +https://world.openfoodfacts.org)';

/** 单品查询 URL（`api/v2/product/{code}.json`）。 */
export function offProductUrl(code: string): string {
  return `${offBaseUrl()}/api/v2/product/${encodeURIComponent(code)}.json`;
}

/** 搜索 URL（`cgi/search.pl`）。 */
export function offSearchUrl(): string {
  return `${offBaseUrl()}/cgi/search.pl`;
}

/** 把未知值安全转数字；非有限值返回 `null`。 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 从 `nutriments` 中读一个「每 100g」数值；缺失返回 `null`。 */
function readNutriment(nutriments: Record<string, unknown>, key: string): number | null {
  return toFiniteNumber(nutriments[key]);
}

/**
 * 提取每 100g 热量（kcal）。
 * 优先 `energy-kcal_100g`；否则用 `energy-kj_100g` / `energy_100g`（kJ）÷ 4.184 换算。
 */
function extractKcalPer100g(nutriments: Record<string, unknown>): number | null {
  const direct = readNutriment(nutriments, 'energy-kcal_100g');
  if (direct !== null) {
    return direct;
  }
  const kj = readNutriment(nutriments, 'energy-kj_100g') ?? readNutriment(nutriments, 'energy_100g');
  if (kj !== null) {
    return kj / 4.184;
  }
  return null;
}

/** 非负宏量：缺失或负值一律归 0。 */
function nonNegative(value: number | null): number {
  return value === null || value < 0 ? 0 : value;
}

/** 分类映射规则（顺序敏感：先具体后笼统）。 */
const CATEGORY_RULES: ReadonlyArray<{ keywords: readonly string[]; category: string }> = [
  {
    keywords: ['beverage', 'drink', 'water', 'tea', 'coffee', 'juice', 'soda', '奶茶', '饮料', '咖啡'],
    category: '饮料',
  },
  {
    keywords: [
      'snack', 'chocolate', 'candy', 'crisps', 'chips', 'biscuit', 'cookie', 'dessert', 'cake',
      'ice cream', '零食', '薯片', '糖',
    ],
    category: '零食',
  },
  { keywords: ['fruit', '水果', '果汁'], category: '水果' },
  { keywords: ['vegetable', 'veg', 'salad', '蔬菜', '番茄', '西红柿'], category: '蔬菜' },
  {
    keywords: [
      'dairy', 'milk', 'cheese', 'yogurt', 'egg', 'meat', 'fish', 'poultry', 'protein',
      '豆', '肉', '蛋', '奶', '水产', '海鲜',
    ],
    category: '蛋白',
  },
  {
    keywords: ['cereal', 'bread', 'rice', 'pasta', 'noodle', 'grain', '主食', '面', '饭', '米粉'],
    category: '主食',
  },
  { keywords: ['fast food', 'takeaway', 'ready meal', '外卖', '快餐', '盒饭'], category: '外卖' },
];

/** 把 OFF 分类文本映射到本项目分类；未命中归 `other`。 */
function mapCategory(product: Record<string, unknown>): string {
  const tags = Array.isArray(product.categories_tags)
    ? product.categories_tags.filter((item): item is string => typeof item === 'string')
    : [];
  const categories = typeof product.categories === 'string' ? product.categories : '';
  const text = `${categories} ${tags.join(' ')}`.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) {
      return rule.category;
    }
  }
  return 'other';
}

/** 取名称：中文名优先，其次原文名 / 通用名；≤80 字。 */
function pickName(product: Record<string, unknown>): string {
  for (const key of ['product_name_zh', 'product_name', 'product_name_en', 'generic_name']) {
    const value = product[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim().slice(0, 80);
    }
  }
  return '';
}

/** 取品牌：`brands` 为逗号分隔，取第一个；≤40 字；无则 `null`。 */
function pickBrand(product: Record<string, unknown>): string | null {
  const value = product.brands;
  if (typeof value !== 'string') {
    return null;
  }
  const first = (value.split(',')[0] ?? '').trim();
  return first.length === 0 ? null : first.slice(0, 40);
}

/** 上游商品页 URL（world 站，用于用户核验与 ODbL 署名）。 */
export function offProductPageUrl(code: string): string {
  return `https://world.openfoodfacts.org/product/${encodeURIComponent(code)}`;
}

/** 解析份量克数：优先 `serving_quantity`，否则从 `serving_size` 文本里抽「数字 + g/克」。 */
function parseServingGrams(product: Record<string, unknown>): number | null {
  const quantity = toFiniteNumber(product.serving_quantity);
  if (quantity !== null && quantity > 0 && quantity <= 5_000) {
    return round1(quantity);
  }
  const size = typeof product.serving_size === 'string' ? product.serving_size : '';
  const matched = /(\d+(?:[.,]\d+)?)\s*(g|gram|grams|克)/i.exec(size);
  if (matched?.[1] !== undefined) {
    const value = Number(matched[1].replace(',', '.'));
    if (Number.isFinite(value) && value > 0 && value <= 5_000) {
      return round1(value);
    }
  }
  return null;
}

/**
 * 归一化一条 OFF 产品为草稿。
 * 返回 `null` 表示该条不可用（缺名称 / 缺条码 / 热量非法），调用方应计入 `skipped`。
 */
export function normalizeOffProduct(product: Record<string, unknown>): ExternalFoodDraft | null {
  const code = String(product.code ?? '').trim();
  if (!BARCODE_PATTERN.test(code)) {
    return null; // 无条码 → 无法幂等入库，直接过滤
  }

  const name = pickName(product);
  if (name.length === 0) {
    return null;
  }

  const nutriments =
    typeof product.nutriments === 'object' && product.nutriments !== null
      ? (product.nutriments as Record<string, unknown>)
      : {};

  const kcal = extractKcalPer100g(nutriments);
  if (kcal === null || !Number.isFinite(kcal) || kcal < 0) {
    return null; // 过滤 NaN / 负值（不做静默转换）
  }

  const servingGrams = parseServingGrams(product);
  const servingUnits: ServingUnit[] =
    servingGrams === null ? [] : [{ unit: '份', grams: servingGrams, isDefault: true }];

  return {
    externalId: code,
    name,
    category: mapCategory(product),
    kcalPer100g: round1(kcal),
    proteinGPer100g: round1(nonNegative(readNutriment(nutriments, 'proteins_100g'))),
    fatGPer100g: round1(nonNegative(readNutriment(nutriments, 'fat_100g'))),
    carbGPer100g: round1(nonNegative(readNutriment(nutriments, 'carbohydrates_100g'))),
    servingUnits,
    defaultServingGrams: servingGrams,
    barcode: code,
    brand: pickBrand(product),
    sourceUrl: offProductPageUrl(code),
  };
}

/** 归一化一批 OFF 产品（过滤脏数据并统计 `skipped`）。 */
function normalizeProducts(rawProducts: unknown[], limit: number): { drafts: ExternalFoodDraft[]; skipped: number } {
  const drafts: ExternalFoodDraft[] = [];
  let skipped = 0;
  for (const raw of rawProducts) {
    if (drafts.length >= limit) {
      break;
    }
    if (typeof raw !== 'object' || raw === null) {
      skipped += 1;
      continue;
    }
    const draft = normalizeOffProduct(raw as Record<string, unknown>);
    if (draft === null) {
      skipped += 1;
      continue;
    }
    drafts.push(draft);
  }
  return { drafts, skipped };
}

/**
 * 搜索 OFF（`cgi/search.pl`）。任何异常均返回 `degraded: true`，绝不抛错。
 *
 * @param query 搜索词（仅此一项被发送给 OFF）
 * @param limit 期望条数（1–20）
 * @param fetchImpl 可注入的 fetch（测试用）
 */
export async function searchOpenFoodFacts(
  query: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<OffSearchOutcome> {
  const url = new URL(offSearchUrl());
  url.searchParams.set('search_terms', query);
  url.searchParams.set('search_simple', '1');
  url.searchParams.set('action', 'process');
  url.searchParams.set('json', '1');
  url.searchParams.set('page_size', String(limit));
  url.searchParams.set(
    'fields',
    'code,product_name,product_name_zh,product_name_en,generic_name,brands,categories,categories_tags,nutriments,serving_size,serving_quantity',
  );

  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': OFF_USER_AGENT },
      signal: AbortSignal.timeout(OFF_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { drafts: [], skipped: 0, degraded: true };
    }
    const payload = (await response.json()) as { products?: unknown };
    const products = Array.isArray(payload.products) ? payload.products : [];
    const { drafts, skipped } = normalizeProducts(products, limit);
    return { drafts, skipped, degraded: false };
  } catch {
    return { drafts: [], skipped: 0, degraded: true };
  }
}

/**
 * 查询 OFF 单品（`api/v2/product/{code}.json`）。任何异常均返回 `degraded: true`。
 *
 * @param code 条码（8–14 位数字）
 * @param fetchImpl 可注入的 fetch（测试用）
 */
export async function fetchOpenFoodFactsProduct(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OffProductOutcome> {
  if (!BARCODE_PATTERN.test(code)) {
    return { draft: null, degraded: false };
  }

  try {
    const response = await fetchImpl(offProductUrl(code), {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': OFF_USER_AGENT },
      signal: AbortSignal.timeout(OFF_TIMEOUT_MS),
    });
    if (response.status === 404) {
      return { draft: null, degraded: false };
    }
    if (!response.ok) {
      return { draft: null, degraded: true };
    }
    const payload = (await response.json()) as { status?: unknown; product?: unknown };
    if (payload.status !== 1 || typeof payload.product !== 'object' || payload.product === null) {
      return { draft: null, degraded: false };
    }
    const draft = normalizeOffProduct(payload.product as Record<string, unknown>);
    return { draft, degraded: false };
  } catch {
    return { draft: null, degraded: true };
  }
}
