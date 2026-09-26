/**
 * 种子合并脚本：把「本地样例集 + Open Food Facts + USDA 精选 + 中国食物成分表」合并为最终种子文件。
 *
 * - 本地样例（57 条，source='local' → 库内 'builtin'）：权威口径的常识值
 * - OFF（source='openfoodfacts'，ODbL 1.0）：中国区/港台区包装食品，署名要求见 README
 * - USDA（source='usda'，public domain）：SR Legacy 精选条目，中文名来自人工翻译映射
 * - CFCD（source='cfcd'）：中国食物成分表（个人非商业自用；来源/许可见 README §8）
 *
 * 幂等：按名称跨源去重（本地样例优先级最高）。
 *
 * ⚠️ 本脚本原为 `merge-seeds.mjs`，已迁移为 **`.ts`**：分类口径现收敛到
 * `@qsh/core` 的 `mapFoodCategory`（唯一真源，见 T1），`.mjs` 无法 import TS，
 * 故改用 `tsx` 运行（仓库根 `node_modules/.bin/tsx` 已可用）。
 *
 * 运行：npx tsx infra/db/seed/merge-seeds.ts
 *
 * 数据质量保障（T4/T6）：
 * - 所有输出条目（含既有 local）一律经 `mapFoodCategory` 归一，杜绝脏分类回灌；
 * - **写出前自动补全 `namePinyin`**（唯一真源 `pinyin.ts`；见下方 P2-1），无需再单独跑 fill-pinyin；
 * - `_meta.sources` 计数**按 items 真实来源统计**（旧实现拿 `existing.items.length`
 *   当 local 数，是错的）；
 * - 输出前**逐条校验**（name 非空 / category ∈ 9 类 / 0 ≤ kcalPer100g ≤ 900 /
 *   每个 servingUnit.grams > 0），任一不合法即抛错并指出第几条、哪个字段。
 *
 * 跨源去重（`normalizeName`，P2-2）：取「括号前主体 + 有区分意义的括号限定词」——
 * 形态/口味/部位/规格（干/鲜/罐头/北/白皮…）**保留**，统计标记/纯数值/品牌产地**丢弃**。
 * 既避免误杀不同形态（如「紫菜(干)」不再被「紫菜（鲜）」顶掉），又保证真同名仍去重。
 *
 * 说明：kcal 下界用 `>= 0` 而非 `> 0` —— 0 是**合法**值（如「无糖气泡水」0 kcal），
 * 强制 > 0 会误杀真实的零热量条目；上界 900 对应纯油脂的物理上限（与采集脚本一致）。
 */

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FOOD_CATEGORIES, isFoodCategory, mapFoodCategory } from '@qsh/core';

import { fillPinyin } from './pinyin';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(here, 'food_items.seed.json');
const OFF_PATH = resolve(here, 'food_items.openfoodfacts.raw.json');
const USDA_PATH = resolve(here, 'food_items.usda.candidates.json');
const USDA_MAP_PATH = resolve(here, 'usda_zh_map.json');
const CFCD_PATH = resolve(here, 'food_items.cfcd.json');

/** 括号组（中/英/方括号，半/全角，开闭可混用）。 */
const BRACKET = /[（(［[]([^）)］\]]*)[）)］\]]/g;
/** 统计标记类限定词（比对去重时忽略）：如「均值」「代表值」。 */
const MARKER_TOKEN = /^(代表值|均值|平均|平均值|mean|avg|约|大概|近似)$/i;
/** 纯测量值限定词（忽略）：以数字开头，如百分比 `38％`、温度 `150℃`、时长 `10分`、度数 `55度`。 */
const MEASURE_TOKEN = /^\d/;
/** 品牌后缀（忽略）：如「可淇牌」「三元牌」。 */
const BRAND_SUFFIX = /牌$/;
/** 常见品牌 / 产地补充说明（忽略）：平台把这些写在括号里、与主体无区分意义。 */
const BRAND_OR_ORIGIN = new Set<string>([
  '雀巢',
  '美赞臣',
  '肯德基',
  '惠氏',
  '亨氏',
  '阿香婆',
  '卡夫',
  '中国',
  '台湾',
  '以色列',
]);

/**
 * 判断括号限定词是否「无区分意义」（去重比对时丢弃）。
 *
 * 区分两类限定词（P2-2 修复）：
 * - **无区分意义**（丢弃）：统计标记、纯数值/温度/时长/度数、品牌/产地补充说明；
 * - **有区分意义**（**保留**）：形态（干/鲜/罐头/油浸/煮/蒸/生）、口味（烧烤/香辣/原味）、
 *   部位/规格（北/南/内酯/白皮/红皮/土鸡/干切面/白/黄）等 —— 这些是**不同食物**，不能归一。
 *
 * @param tok 单个括号限定词
 */
function isMeaninglessToken(tok: string): boolean {
  return (
    MARKER_TOKEN.test(tok) || MEASURE_TOKEN.test(tok) || BRAND_SUFFIX.test(tok) || BRAND_OR_ORIGIN.has(tok)
  );
}

/**
 * 归一化名称（用于跨源去重比对）。
 *
 * 取「括号前主体 + **有区分意义**的括号限定词」，去空白/常用标点、转小写。
 * 例：`紫菜(干)`→`紫菜干`（**≠** `紫菜（鲜）`→`紫菜鲜`，故「干紫菜」不再被「鲜紫菜」误杀）；
 * 而 `苹果`→`苹果` 与既有 `苹果` 真同名**仍会去重**。
 *
 * ⚠️ 与旧实现的关键差异：旧版把括号内容**全部删除**，导致 `紫菜(干)` 与 `紫菜（鲜）`
 * 归一为同名 → 误杀干制品/不同形态；本版仅丢弃「无区分意义」的限定词。
 *
 * @param name 原始食物名
 */
function normalizeName(name: string): string {
  const raw = String(name);
  const base = raw.split(/[（(［[]/)[0].trim();
  const kept: string[] = [];
  for (const match of raw.matchAll(BRACKET)) {
    for (const part of match[1].split(/[，,、/]/)) {
      const tok = part.trim();
      if (tok !== '' && !isMeaninglessToken(tok)) {
        kept.push(tok);
      }
    }
  }
  return (base + kept.join(''))
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，,、。.·・\-—_/％%]/g, '')
    .toLowerCase();
}

/** 自然份量单位。 */
interface ServingUnit {
  unit: string;
  grams: number;
  isDefault?: boolean;
  label?: string;
}
/** 一条种子食物。 */
interface SeedItem {
  name: string;
  category: string;
  source: string;
  kcalPer100g: number;
  servingUnits: ServingUnit[];
  [key: string]: unknown;
}

/**
 * 逐条校验种子条目；失败**收集全部问题后抛出**（指出第几条 / 哪个字段 / 何值）。
 *
 * @param items 待校验条目
 * @param where 来源描述（用于报错定位）
 */
function validateItems(items: SeedItem[], where: string): void {
  const problems: string[] = [];
  items.forEach((item, index) => {
    const at = `${where} 第 ${index + 1} 条「${item.name ?? '<无名>'}」`;
    if (typeof item.name !== 'string' || item.name.trim() === '') {
      problems.push(`${at}：name 为空`);
    }
    if (!isFoodCategory(item.category)) {
      problems.push(`${at}：category=${JSON.stringify(item.category)} 非法（应为 ${FOOD_CATEGORIES.join('/')}）`);
    }
    if (!(typeof item.kcalPer100g === 'number') || !Number.isFinite(item.kcalPer100g) || item.kcalPer100g < 0 || item.kcalPer100g > 900) {
      problems.push(`${at}：kcalPer100g=${JSON.stringify(item.kcalPer100g)} 必须在 [0, 900] 内`);
    }
    const units = item.servingUnits ?? [];
    if (!Array.isArray(units) || units.length === 0) {
      problems.push(`${at}：servingUnits 为空`);
    } else {
      units.forEach((unit, unitIndex) => {
        if (!(typeof unit.grams === 'number') || !(unit.grams > 0)) {
          problems.push(`${at}：servingUnits[${unitIndex}].grams=${JSON.stringify(unit.grams)} 必须 > 0`);
        }
      });
    }
  });
  if (problems.length > 0) {
    throw new Error(`种子校验未通过（${problems.length} 处）：\n  - ${problems.join('\n  - ')}`);
  }
}

// 备份当前种子（一次性）
try {
  copyFileSync(SEED_PATH, `${SEED_PATH}.bak`);
} catch {
  /* 首次运行无种子文件 */
}

const existing = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as { _meta?: Record<string, unknown>; items: SeedItem[] };
const off = JSON.parse(readFileSync(OFF_PATH, 'utf8')) as { items: SeedItem[] };
const usda = JSON.parse(readFileSync(USDA_PATH, 'utf8')) as { items: Array<{ ndbNumber: number | string; category: string } & SeedItem> };
const zhMap = JSON.parse(readFileSync(USDA_MAP_PATH, 'utf8')) as {
  picks: Array<{ ndb: number | string; zh: string; category: string }>;
};

const usdaByNdb = new Map(usda.items.map((item) => [String(item.ndbNumber), item]));

// ⚠️ 既有条目里的 **CFCD 部分一律剔除**：CFCD 以 `food_items.cfcd.json` 为**唯一真源**，
// 每次合并都从 cfcd.json **重建**（见下方 cfcdItems）。
// 否则：改了 cfcd.json（如新增「平台内同名去重」）后，merge 会拿这份旧 CFCD 当既有集合去比对，
// 结果**所有新 CFCD 都被当成同名跳过**，旧数据（含重复条目）永久残留、无法反灌。
const existingBase = existing.items.filter((item) => item.source !== 'cfcd');
const seen = new Set(existingBase.map((item) => item.name));

// 既有非 CFCD 条目也过一遍归一（幂等；本地样例优先级最高，故先入 seen 并用其名字）
const localItems: SeedItem[] = existingBase.map((item) => ({
  ...item,
  category: mapFoodCategory(item.category, item.name),
}));

const offItems: SeedItem[] = [];
for (const item of off.items) {
  if (seen.has(item.name)) continue;
  seen.add(item.name);
  offItems.push({
    name: item.name,
    namePinyin: item.namePinyin ?? null,
    aliases: item.aliases ?? [],
    category: mapFoodCategory(item.category, item.name),
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
    offCode: (item as { offCode?: string }).offCode,
  });
}

const usdaItems: SeedItem[] = [];
const skippedNoMap: Array<number | string> = [];
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
    category: mapFoodCategory(pick.category, name),
    kcalPer100g: raw.kcalPer100g,
    protein: raw.protein,
    fat: raw.fat,
    carbs: raw.carbs,
    fiber: raw.fiber,
    sodium: raw.sodium,
    sugar: raw.sugar,
    saturatedFat: (raw as { saturatedFat?: number | null }).saturatedFat ?? null,
    servingUnits: [{ unit: '100克', grams: 100, isDefault: true }],
    source: 'usda',
    isCustom: false,
    usdaNdb: String(raw.ndbNumber),
  });
}

// —— CFCD（中国食物成分表）扩量数据 ——
// 去重：与「既有种子」按**归一化名**比对（去括号内容 + 空白 + 标点），命中即跳过；
// 但**不**把 CFCD 自身加入 `seen` —— 平台内部同名不同 foodId（如「鸡蛋(白皮)/(红皮)」）
// 需全部保留，故仅与既有集合比对。
let cfcdFile: { items: SeedItem[] } = { items: [] };
try {
  cfcdFile = JSON.parse(readFileSync(CFCD_PATH, 'utf8')) as { items: SeedItem[] };
} catch {
  cfcdFile = { items: [] }; // 尚未抓取 / 转换时静默跳过
}
const existingNormalized = new Set(existingBase.map((item) => normalizeName(item.name)));
const cfcdItems: SeedItem[] = [];
let cfcdSkipped = 0;
for (const item of cfcdFile.items ?? []) {
  if (existingNormalized.has(normalizeName(item.name))) {
    cfcdSkipped += 1;
    continue;
  }
  cfcdItems.push({ ...item, category: mapFoodCategory(item.category, item.name) });
}

const items: SeedItem[] = [...localItems, ...offItems, ...usdaItems, ...cfcdItems];

// P2-1：写出前**自动补全拼音**（唯一真源 `pinyin.ts`）。
// 背景：CFCD 条目由下面的 CFCD 段重建、`namePinyin` 为 null；若靠「记得单独跑 fill-pinyin」
// 极易遗漏（曾导致 cfcd 拼音 0/1245、拼音搜索失效）。内聚进 merge 后，任何重跑都不会再丢。
const pinyinResult = fillPinyin(items);

// T6：输出前校验（失败即抛错，绝不写脏数据）
validateItems(items, '合并结果');

// T4：来源计数按真实 items 统计
function countBySource(rows: SeedItem[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const key = String(row.source ?? '');
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}
const sourceCount = countBySource(items);

const merged = {
  _meta: {
    description: '「轻生活」食物库种子：本地合规样例集 + Open Food Facts + USDA SR Legacy 精选 + 中国食物成分表',
    dataSource:
      '① 本地样例集：常识级公开营养值（57 条，权威口径）；' +
      '② Open Food Facts：开放许可 ODbL 1.0，© Open Food Facts contributors，采集区域为中国大陆/中国香港/中国台湾地区包装食品；' +
      '③ USDA FoodData Central SR Legacy：美国农业部公有领域数据，中文名为人工翻译，来源已逐条标注；' +
      '④ 中国食物成分表（中国营养学会 / 中国疾控中心营养与健康所）：仅个人非商业自用，未经书面允许不得用于商业目的、不得再分发（详见 README §8）',
    precision:
      '全部为每 100g 数值；样例集取常识中位值，OFF/USDA 为原始测定/申报值（保留 1 位小数）。' +
      '数据用于日常记录参考，不构成营养诊断',
    sources: {
      local: { count: sourceCount.get('local') ?? 0, license: '自建常识样例' },
      openfoodfacts: {
        count: sourceCount.get('openfoodfacts') ?? 0,
        license: 'ODbL 1.0（需署名并同许可共享）',
        url: 'https://world.openfoodfacts.org',
      },
      usda: {
        count: sourceCount.get('usda') ?? 0,
        license: 'Public Domain（USDA FoodData Central SR Legacy）',
        url: 'https://fdc.nal.usda.gov',
      },
      cfcd: {
        count: sourceCount.get('cfcd') ?? 0,
        license: '个人非商业自用（中国食物成分表，未经书面允许不得用于商业目的；不得再分发）',
        url: 'https://nlc.chinanutri.cn/fq/',
      },
    },
    todo: (existing._meta?.todo as string) ?? '扩量至 500 条以上需客户提供授权数据集，严禁编造营养数值',
    itemCount: items.length,
  },
  items,
};

writeFileSync(SEED_PATH, JSON.stringify(merged, null, 2));
console.log(
  `合并完成：本地 ${localItems.length} + OFF ${offItems.length} + USDA ${usdaItems.length}` +
    ` + CFCD ${cfcdItems.length}（跳过同名 ${cfcdSkipped}）` +
    ` = ${items.length} 条`,
);
console.log(
  `_meta.sources 按真实来源统计：local ${sourceCount.get('local') ?? 0} / ` +
    `openfoodfacts ${sourceCount.get('openfoodfacts') ?? 0} / usda ${sourceCount.get('usda') ?? 0} / ` +
    `cfcd ${sourceCount.get('cfcd') ?? 0}`,
);
console.log(
  `拼音补全：原有 ${pinyinResult.kept} + 新补 ${pinyinResult.filled} = ` +
    `${pinyinResult.kept + pinyinResult.filled}/${items.length}（跳过 ${pinyinResult.skipped.length}：纯日文/英文名）`,
);
if (skippedNoMap.length > 0) {
  console.log(`（${skippedNoMap.length} 个 ndb 在候选中未找到，已跳过：${skippedNoMap.join(',')}）`);
}
