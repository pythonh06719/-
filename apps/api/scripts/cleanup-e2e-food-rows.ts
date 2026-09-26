/**
 * 清理本地 `dev.db` 中 e2e / QA 残留的食物条目（「食物库数据质量」T7）。
 *
 * 背景：e2e / QA 用例会往 `food_items` 写测试条目（如「米饭（agent 测试）」
 * 「米饭（confirm 并发测试）」「米饭（QA 探针）」等，均为 `source='builtin'`），
 * 若用例未清理，会在本地库累积（本次实测 149 条）。
 *
 * **判据（安全且精确）**：删除「`source='builtin'` 且 `name` 不在本地样例集
 * （`food_items.seed.json` 中 `source==='local'` 的条目名）内」的行。
 * 因此**绝不会误删真实的 57 条 builtin**；也不碰 openfoodfacts / usda。
 *
 * 关联行为（与 schema 一致，K9）：收藏 `food_favorites` 级联删除；
 * 饮食记录 `meal_logs` / 套餐明细 `meal_combo_items` 的 `food_item_id` 置 NULL。
 *
 * 运行：
 *   npx tsx apps/api/scripts/cleanup-e2e-food-rows.ts           # 试运行（只报告）
 *   npx tsx apps/api/scripts/cleanup-e2e-food-rows.ts --write    # 实际删除
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url)); // apps/api/scripts
const apiRoot = resolve(here, '..'); // apps/api
const repoRoot = resolve(here, '../../..');

for (const envPath of [resolve(apiRoot, '.env'), resolve(repoRoot, '.env')]) {
  loadEnv({ path: envPath });
}

const SEED_PATH = resolve(repoRoot, 'infra/db/seed/food_items.seed.json');
const WRITE = process.argv.includes('--write');

/** 本地样例集（种子 source==='local'）→ 落库映射为 builtin，是唯一「合法 builtin」。 */
function localBuiltinNames(): Set<string> {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as {
    items: Array<{ name: string; source: string }>;
  };
  return new Set(seed.items.filter((item) => item.source === 'local').map((item) => item.name));
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const legit = localBuiltinNames();
    const builtin = await prisma.foodItem.findMany({
      where: { source: 'builtin' },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    const junk = builtin.filter((row) => !legit.has(row.name));

    console.log(
      `[dev.db] builtin 共 ${builtin.length} 条（合法 ${builtin.length - junk.length} / 测试残留 ${junk.length}）`,
    );
    if (junk.length === 0) {
      console.log('无需清理。');
      return;
    }
    const sample = junk.slice(0, 5).map((row) => `${row.id}:${row.name}`).join(', ');
    console.log(`[dev.db] 残留样例：${sample}${junk.length > 5 ? ' …' : ''}`);

    if (!WRITE) {
      console.log('\n（试运行，未删除；加 --write 生效）');
      return;
    }

    const ids = junk.map((row) => row.id);
    const result = await prisma.foodItem.deleteMany({ where: { id: { in: ids } } });
    console.log(`[dev.db] 已删除 ${result.count} 条测试残留`);

    const remaining = await prisma.foodItem.count({ where: { source: 'builtin' } });
    console.log(`[dev.db] 剩余 builtin：${remaining} 条（应为 ${builtin.length - junk.length}）`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[cleanup] 失败：', error);
  process.exitCode = 1;
});
