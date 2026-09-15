/**
 * 食物库种子载入脚本（幂等 upsert）。
 *
 * 数据源：`infra/db/seed/food_items.seed.json`（中式食物库种子，来源与版权见同级 README.md）。
 *
 * 幂等策略：本表 `name` 无唯一约束（与 docs/SCHEMA.sql 对齐），故以
 * `(name, source='builtin', createdByUserId IS NULL)` 为业务键做 findFirst → update / create，
 * 反复执行不会产生重复行。
 *
 * 字段映射：
 * - 种子 `source: "local"` 是**数据来源标记**（本地合规样例集），落库统一映射为
 *   `food_items.source = 'builtin'`（DB 枚举仅允许 builtin / openfoodfacts / user_custom）。
 * - `servingUnits` / `aliases` 序列化为 JSON 文本（SQLite TEXT；PG 为 jsonb）。
 * - `defaultServingGrams` 取 `servingUnits` 中 `isDefault=true`（缺省取第一个）的克数。
 *
 * 运行：`npm run db:seed`（等价 `tsx prisma/seed.ts`）。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';

// ---------------------------------------------------------------------------
// 种子文件类型（与 infra/db/seed/food_items.seed.json 结构一致）
// ---------------------------------------------------------------------------

/** 种子自然份量单位（对应 DB `serving_units` 元素，ARCHITECTURE §3.3）。 */
interface SeedServingUnit {
  /** 个/碗/杯/片/袋… */
  unit: string;
  /** 该单位对应克数（> 0） */
  grams: number;
  /** 默认选中单位（每项至多 1 个 true） */
  isDefault?: boolean;
  /** 展示别名（可选） */
  label?: string;
}

/** 单条种子食物（每 100g 营养）。 */
interface SeedFoodItem {
  name: string;
  namePinyin?: string;
  aliases?: string[];
  category: string;
  kcalPer100g: number;
  protein: number;
  fat: number;
  carbs: number;
  fiber?: number | null;
  sodium?: number | null;
  sugar?: number | null;
  saturatedFat?: number | null;
  servingUnits: SeedServingUnit[];
  /** 数据来源标记（'local' = 本地合规样例集；'openfoodfacts' = OFF 采集，ODbL） */
  source: string;
  /** 是否用户自定义（种子一律 false） */
  isCustom: boolean;
}

/** 种子文件顶层结构。 */
interface SeedFile {
  _meta: {
    description: string;
    dataSource: string;
    precision: string;
    todo: string;
    itemCount: number;
    [key: string]: unknown;
  };
  items: SeedFoodItem[];
}

// ---------------------------------------------------------------------------
// 路径解析（同时兼容从仓库根 / apps/api 运行）
// ---------------------------------------------------------------------------

const here: string = dirname(fileURLToPath(import.meta.url)); // apps/api/prisma
const apiRoot: string = resolve(here, '..'); // apps/api
const repoRoot: string = resolve(here, '../../..'); // 仓库根 qingshenghuo/

// 先加载环境变量（apps/api/.env 优先，其次仓库根 .env），再实例化 PrismaClient
for (const envPath of [resolve(apiRoot, '.env'), resolve(repoRoot, '.env')]) {
  loadEnv({ path: envPath });
}

const SEED_PATH: string = resolve(repoRoot, 'infra/db/seed/food_items.seed.json');
const MET_SEED_PATH: string = resolve(repoRoot, 'infra/db/seed/met_activities.seed.json');
const HABIT_SEED_PATH: string = resolve(repoRoot, 'infra/db/seed/habit_templates.seed.json');

/** MET 种子条目。 */
interface SeedMetActivity {
  code: string;
  name: string;
  category: string;
  intensity?: string;
  met: number;
}

/** 习惯模板种子条目。 */
interface SeedHabit {
  code: string;
  name: string;
  icon?: string;
  targetPerDay?: number;
}

/** 主流程：读取种子文件并幂等 upsert 到 `food_items` / `met_activities` / `habit_definitions`。 */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await seedFoods(prisma);
    await seedMetActivities(prisma);
    await seedHabits(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/** 食物库种子（一期）。 */
async function seedFoods(prisma: PrismaClient): Promise<void> {
  const raw: string = readFileSync(SEED_PATH, 'utf8');
  const seed: SeedFile = JSON.parse(raw) as SeedFile;

  if (!Array.isArray(seed.items) || seed.items.length === 0) {
    throw new Error(`种子文件无有效 items：${SEED_PATH}`);
  }

  let created = 0;
  let updated = 0;

  for (const item of seed.items) {
    const servingUnits: SeedServingUnit[] = item.servingUnits ?? [];
    const defaultUnit: SeedServingUnit | undefined =
      servingUnits.find((u) => u.isDefault === true) ?? servingUnits[0];

      const data = {
        name: item.name,
        namePinyin: item.namePinyin ?? null,
        aliases: JSON.stringify(item.aliases ?? []),
        category: item.category,
        kcalPer100g: item.kcalPer100g,
        proteinGPer100g: item.protein ?? 0,
        fatGPer100g: item.fat ?? 0,
        carbGPer100g: item.carbs ?? 0,
        fiberGPer100g: item.fiber ?? null,
        sodiumMgPer100g: item.sodium ?? null,
        sugarGPer100g: item.sugar ?? null,
        saturatedFatGPer100g: item.saturatedFat ?? null,
        servingUnits: JSON.stringify(servingUnits),
        defaultServingGrams: defaultUnit ? defaultUnit.grams : null,
        // 种子 'local' → DB 'builtin'（本地合规样例集）；'openfoodfacts'/'usda' 原样保留（署名见 README）
        source: item.source === 'openfoodfacts' || item.source === 'usda' ? item.source : 'builtin',
        createdByUserId: null,
        isVerified: false,
      };

      const existing = await prisma.foodItem.findFirst({
        where: { name: item.name, source: data.source, createdByUserId: null },
        select: { id: true },
      });

    if (existing) {
      await prisma.foodItem.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.foodItem.create({ data });
      created += 1;
    }
  }

  const totalBuiltin: number = await prisma.foodItem.count({ where: { source: 'builtin' } });
  console.log(
    `[seed] 食物库：created=${created} updated=${updated} 种子条数=${seed.items.length} builtin总数=${totalBuiltin}`,
  );
}

/** MET 活动表种子（二期 R6.1，幂等：按 `code` upsert）。 */
async function seedMetActivities(prisma: PrismaClient): Promise<void> {
  const raw: string = readFileSync(MET_SEED_PATH, 'utf8');
  const seed = JSON.parse(raw) as { activities: SeedMetActivity[] };

  let created = 0;
  let updated = 0;
  for (const activity of seed.activities) {
    const data = {
      code: activity.code,
      name: activity.name,
      category: activity.category,
      intensity: activity.intensity ?? null,
      met: activity.met,
      isBuiltin: true,
      source: '2024 成人活动 MET 汇编',
    };
    const existing = await prisma.metActivity.findUnique({ where: { code: activity.code } });
    if (existing) {
      await prisma.metActivity.update({ where: { code: activity.code }, data });
      updated += 1;
    } else {
      await prisma.metActivity.create({ data });
      created += 1;
    }
  }
  console.log(`[seed] MET 活动：created=${created} updated=${updated}`);
}

/** 习惯模板种子（二期 R7.3，幂等：`userId=null` + `code`）。 */
async function seedHabits(prisma: PrismaClient): Promise<void> {
  const raw: string = readFileSync(HABIT_SEED_PATH, 'utf8');
  const seed = JSON.parse(raw) as { habits: SeedHabit[] };

  let created = 0;
  let updated = 0;
  for (const habit of seed.habits) {
    const data = {
      code: habit.code,
      name: habit.name,
      icon: habit.icon ?? null,
      targetPerDay: habit.targetPerDay ?? 1,
      isActive: true,
      userId: null,
    };
    const existing = await prisma.habitDefinition.findFirst({
      where: { code: habit.code, userId: null },
      select: { id: true },
    });
    if (existing) {
      await prisma.habitDefinition.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.habitDefinition.create({ data });
      created += 1;
    }
  }
  console.log(`[seed] 习惯模板：created=${created} updated=${updated}`);
}

main().catch((error: unknown) => {
  console.error('[seed] 载入失败：', error);
  process.exitCode = 1;
});
