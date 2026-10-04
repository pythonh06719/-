/**
 * 修复本地 `dev.db` 中「自建习惯与内置习惯 `code` 同名」的数据完整性缺陷。
 *
 * ## 背景
 *
 * `HabitDefinition.userId` 为 `NULL` 表示内置模板。`schema.prisma:402` 的
 * `@@unique([userId, code])` **拦不住**跨作用域重名 —— SQLite 唯一索引认为
 * NULL 与 NULL 互不相等，且 `(NULL,'water')` 与 `(840,'water')` 本就是不同的键。
 * 于是 QA 用 `code: 'water'` 等内置同名值造数后，内置与自建同名共存。
 *
 * ## 为什么危害远不止「UI 出现两张一样的卡」
 *
 * `packages/shared-types/src/export.ts:93` 规定 `ExportHabitRow.habitId ← code` ——
 * `code` 是**备份文件里识别一个习惯的唯一钥匙**。而
 * `packages/core/src/export/payload.ts:309` 对 `habits[]` 断言唯一键是
 * **`日期|habitId`**。所以当同名习惯在同一天都打过卡，导出文件会出现两行
 * 重复的 `日期|habitId` → **该用户的备份从此再也恢复不回来**
 * （实测报 `E_VALID_RESTORE_PAYLOAD`）。次生问题：`data.service.ts:482` 恢复时
 * 按 `code` 反查（`orderBy: userId desc`），同名会让内置与自建折叠成同一个
 * `habitId`，两边打卡合并成一条历史。
 *
 * ## ⚠️ 为什么**只改名、绝不删除**（`onDelete: Cascade` 陷阱）
 *
 * `HabitCheckin.habitId` 的外键是 **`onDelete: Cascade`**
 * （`schema.prisma:417`，注释见 `habits.service.ts` 的 `setActive` 说明）。
 * 一旦 `DELETE` 这些重复项，该习惯的**全部历史打卡会被级联删除且不可恢复**：
 *   1. 用户过去数十天的打卡数据凭空消失；
 *   2. 历史周报的 `habitsDone` / `habitsTotal` 基数变化 → **历史周报数字被改写**；
 *   3. 违背本项目「无负罪感」原则 —— 想「整理一下」不等于「抹掉过去」。
 *
 * 因此本脚本**只 `UPDATE code`**，把与内置重名的自建 code 收敛成
 * `<原 code>__dup_<id>`（确定性、可复现），**`habit_definitions` 行本身与
 * `habit_checkins` 打卡记录一条都不动**。改名后：
 *   - 备份里的 `日期|habitId` 不再重复 → 恢复得回来；
 *   - 12 张重复卡降到 8 张（内置 6 + 真正自建 2），且展示层可区分。
 *
 * ## 判据（安全且精确）
 *
 * 只处理「**自建**（`user_id` 非空）且**与某条内置模板 code 同名**」的行。
 * 绝不触碰：
 *   - 内置模板本身（`user_id IS NULL`）；
 *   - code 不与内置重名的自建习惯（如 `no_latenight` / `log_meals` 这类真自建项）；
 *   - 任何 `habit_checkins` 行。
 *
 * 运行：
 *   npx tsx apps/api/scripts/fix-duplicate-habit-codes.ts           # 试运行（只报告，不写库）
 *   npx tsx apps/api/scripts/fix-duplicate-habit-codes.ts --write   # 实际改名
 *
 * 回滚：改名是确定性的，把 `__dup_<id>` 后缀去掉即可还原
 *（`UPDATE habit_definitions SET code = replace(code,'__dup_'||id,'') ...`，仅限带该后缀的行）。
 */

import { PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // apps/api/scripts
const apiRoot = resolve(here, '..'); // apps/api
const repoRoot = resolve(here, '../../..');

for (const envPath of [resolve(apiRoot, '.env'), resolve(repoRoot, '.env')]) {
  loadEnv({ path: envPath });
}

const WRITE = process.argv.includes('--write');

/** 收敛后的确定性后缀（与 `habits.service.ts` 的 `resolveCode` 派生风格一致）。 */
function convergedCode(code: string, id: number): string {
  return `${code}__dup_${id}`;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  // 内置模板的 code 集合（user_id IS NULL）
  const builtinCodes = new Set(
    (await prisma.habitDefinition.findMany({ where: { userId: null }, select: { code: true } })).map(
      (row) => row.code,
    ),
  );

  // 自建习惯中，与内置 code 同名的行
  const candidates = (await prisma.habitDefinition.findMany({ where: { userId: { not: null } } })).filter(
    (row) => builtinCodes.has(row.code),
  );

  if (candidates.length === 0) {
    console.log('[fix-habit-code] 没有发现与内置同名的自建习惯，无需处理。');
    await prisma.$disconnect();
    return;
  }

  console.log(`[fix-habit-code] 发现 ${candidates.length} 条与内置模板重名的自建习惯：`);
  for (const row of candidates) {
    // 打卡条数：证明「删除会毁掉多少历史」，也是改名后必须保持不变的数量
    const checkins = await prisma.habitCheckin.count({ where: { habitId: row.id } });
    const next = convergedCode(row.code, row.id);
    console.log(
      `  id=${row.id} userId=${row.userId} code="${row.code}" → "${next}"` +
        `（name="${row.name}"，历史打卡 ${checkins} 条${checkins > 0 ? '，必须保留' : ''}）`,
    );
  }

  if (!WRITE) {
    console.log('[fix-habit-code] 试运行结束（未写库）。加 --write 执行实际改名。');
    await prisma.$disconnect();
    return;
  }

  // 逐条改名；**绝不 delete**（HabitCheckin.habitId 是 onDelete: Cascade）
  for (const row of candidates) {
    const before = await prisma.habitCheckin.count({ where: { habitId: row.id } });
    await prisma.habitDefinition.update({
      where: { id: row.id },
      data: { code: convergedCode(row.code, row.id) },
    });
    const after = await prisma.habitCheckin.count({ where: { habitId: row.id } });
    if (before !== after) {
      throw new Error(`id=${row.id} 的打卡条数从 ${before} 变成 ${after}，数据被改动了，请立即排查`);
    }
  }

  // 复核：不应再有「自建 code 与内置重名」的行
  const remaining = (await prisma.habitDefinition.findMany({ where: { userId: { not: null } } })).filter(
    (row) => builtinCodes.has(row.code),
  );
  console.log(`[fix-habit-code] 完成。残留重名行：${remaining.length} 条；所有历史打卡保持原样。`);
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error('[fix-habit-code] 执行失败：', error);
  process.exitCode = 1;
});
