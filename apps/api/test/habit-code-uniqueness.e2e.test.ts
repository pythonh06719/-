/**
 * 习惯 `code` 重复的数据完整性缺陷 —— 端到端测试（真实 HTTP）。
 *
 * ## 缺陷是什么
 *
 * `HabitDefinition` 允许「自建习惯」与「内置习惯」（`userId=null`）的 `code` 重复，
 * UI 上于是出现两张一样的卡。QA 造数时用 `code: 'water'` 等与内置同名的值批量建习惯，
 * 实测 `GET /habits` 返回 12 张卡。
 *
 * ## 为什么这不是「UI 不好看」，而是数据完整性问题（本文件的核心断言）
 *
 * `packages/shared-types/src/export.ts:93` 明确：`ExportHabitRow.habitId ← code`
 * —— 导出用 `code` 冒充 habitId，它是**备份文件里识别一个习惯的唯一钥匙**。
 * 而 `packages/core/src/export/payload.ts:309` 对 `habits[]` 断言唯一键是
 * **`日期|habitId`**。于是：
 *
 * > 自建与内置 `code` 同名 + 同一天都打了卡 ⇒ 导出文件出现两行相同 `日期|habitId`
 * ⇒ **用户自己的备份从此再也恢复不回来**（`E_VALID_RESTORE_PAYLOAD`）。
 *
 * 次生问题：`data.service.ts:482` 恢复时按 `code` 反查（`orderBy: userId desc`），
 * 同名会让内置与自建折叠成同一个 `habitId`，两边打卡合并成一条历史。
 *
 * ## 为什么不能靠数据库唯一索引解决
 *
 * `schema.prisma:402` 已有 `@@unique([userId, code])`，但 **SQLite 的唯一索引认为
 * NULL 与 NULL 互不相等**（本文件 `SQLite NULL 语义` 一节有实测断言），
 * 所以 `(NULL,'water')` 连插两条都成功，内置与自建更是两个不同的键 → 索引拦不住。
 * 要用索引表达「内置 ∪ 本人」这个合并作用域，得引入 `COALESCE(userId,0)` 表达式索引，
 * 属 schema 改动，需明确立项（见报告），本次不擅自做。
 *
 * ## 处置口径：无负罪感 —— **不拦用户、不报错、名字照写**
 *
 * 用户在 UI 上填的是**名字**，`code` 从不暴露给他（前端自己生成 `custom_<ts>`）。
 * 为一个用户没填过的字段拦下「想加个自己的喝水」这个正当诉求，既替用户做决定、
 * 又带说教感。因此命中冲突时**创建照常成功**，只在数据层把 `code` 收敛成不冲突的派生值，
 * 展示层如何区分交给 UI。
 *
 * ## 机制
 *
 * 与既有 e2e 同机制：通过 Node 原生 `require` 加载 `nest build` 产物（tsc 产物带装饰器元数据）。
 * 运行前必须先 build（且注意 `nest build` 的 safe-delete 坑：旧 `dist` 会被静默保留）。
 */

import 'reflect-metadata';

import { createRequire } from 'node:module';

import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppModule as AppModuleClass } from '../src/app.module';
import type { PrismaService as PrismaServiceClass } from '../src/prisma/prisma.service';

const require = createRequire(import.meta.url);

const { Test } = require('@nestjs/testing') as typeof import('@nestjs/testing');
const request = require('supertest') as unknown as typeof import('supertest');
const core = require('../dist/packages/core/src/index.js') as typeof import('@qsh/core');
const { AppModule } = require('../dist/apps/api/src/app.module.js') as {
  AppModule: typeof AppModuleClass;
};
const { PrismaService } = require('../dist/apps/api/src/prisma/prisma.service.js') as {
  PrismaService: typeof PrismaServiceClass;
};

const { parseExportPayload, toLocalDateKey } = core;

const API = '/api';
const EMAIL = 'e2e-habit-code@qinglife.test';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let token = '';
let userId = 0;

function auth(): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** 创建一个习惯，返回完整响应体（不断言状态码，便于断言各种情形）。 */
function createHabit(
  code: string,
  name: string,
): Promise<{ status: number; body: { data?: any; error?: any } }> {
  return request(server as never)
    .post(`${API}/habits`)
    .set(auth())
    .send({ code, name })
    .then((res) => ({ status: res.status, body: res.body }));
}

/** 打卡（`done:true`）。 */
function checkin(habitId: number, loggedDate?: string): Promise<{ status: number; body: any }> {
  return request(server as never)
    .post(`${API}/habits/${habitId}/check`)
    .set(auth())
    .send(loggedDate === undefined ? { done: true } : { done: true, loggedDate })
    .then((res) => ({ status: res.status, body: res.body }));
}

async function listHabits(): Promise<Array<Record<string, any>>> {
  const res = await request(server as never).get(`${API}/habits`).set(auth()).expect(200);
  return (res.body.data as { habits: Array<Record<string, any>> }).habits;
}

/** 导出当前用户全部数据。 */
async function exportAll(): Promise<any> {
  const res = await request(server as never).get(`${API}/data/export`).set(auth()).expect(200);
  return res.body.data;
}

/** 拿一份最小但合法的备份骨架（只关心 `habits` 段）。 */
function backupSkeleton(habits: Array<{ date: string; habitId: string; done: boolean }>): string {
  return JSON.stringify({
    meta: { app: 'qingshenghuo', schemaVersion: 2, exportedAt: '2026-10-04T00:00:00.000Z' },
    profile: {
      gender: 'female',
      birthDate: '1992-04-03',
      heightCm: 165,
      activityLevel: 'light',
      dietaryPreference: [],
      conditions: [],
    },
    goals: { targetWeightKg: 58, targetWeeks: 12, macroRatio: { protein: 25, fat: 25, carb: 50 } },
    weights: [],
    meals: [],
    exercises: [],
    habits,
    water: [],
    wins: [],
    settings: { unit: 'kcal', weightUnit: 'kg', darkMode: false, fastingEnabled: false, waterGoalMl: 2000 },
  });
}

beforeAll(async () => {
  process.env.AUTH_LOG_CODE = 'true';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  server = app.getHttpServer();
  prisma = moduleRef.get<PrismaServiceClass>(PrismaService);

  await prisma.authVerificationCode.deleteMany({ where: { email: EMAIL } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });

  const sent = await request(server as never).post(`${API}/auth/send-code`).send({ email: EMAIL }).expect(200);
  const code = (sent.body.data as { code?: string }).code;
  const verified = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email: EMAIL, code })
    .expect(200);
  const data = verified.body.data as { accessToken: string; user: { id: number } };
  token = data.accessToken;
  userId = data.user.id;
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.authVerificationCode.deleteMany({ where: { email: EMAIL } });
    await prisma.user.deleteMany({ where: { email: EMAIL } });
  }
  if (app !== undefined) await app.close();
});

// ---------------------------------------------------------------------------
// 前置事实：SQLite 唯一索引的 NULL 语义（解释「为什么索引拦不住」）
// ---------------------------------------------------------------------------

describe('前置事实 · SQLite 唯一索引的 NULL 语义', () => {
  it('(NULL,code) 可重复插入，且与 (userId,code) 是不同的键', () => {
    // `require` 走 Node 原生模块加载（无类型标注），故无需处理 node:sqlite 的类型
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, user_id INTEGER, code TEXT)');
    db.exec('CREATE UNIQUE INDEX ux ON t(user_id, code)');

    // 内置模板：user_id 为 NULL —— 与 habit_definitions 的内置模板形态一致
    db.prepare('INSERT INTO t (user_id, code) VALUES (NULL, ?)').run('water');
    // SQLite 认为 NULL 与 NULL 互不相等 → 第二条内置同名照样能进（索引形同虚设）
    expect(() => db.prepare('INSERT INTO t (user_id, code) VALUES (NULL, ?)').run('water')).not.toThrow();

    // 自建习惯与内置同名：user_id 不同 → 也是不同的键
    expect(() => db.prepare('INSERT INTO t (user_id, code) VALUES (840, ?)').run('water')).not.toThrow();

    // 但「同一个用户的两个自建习惯同名」会被索引拦住
    expect(() => db.prepare('INSERT INTO t (user_id, code) VALUES (840, ?)').run('water')).toThrow();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 核心：备份可恢复性（这才是本缺陷的实质危害）
// ---------------------------------------------------------------------------

describe('核心 · code 重复会让用户自己的备份恢复不回来', () => {
  it('解析器基线：同一日期两条相同 habitId → 备份被判为不合法', () => {
    const ok = parseExportPayload(
      backupSkeleton([{ date: '2026-10-04', habitId: 'water', done: true }]),
    );
    expect(ok.ok, '单条应可解析').toBe(true);

    const dup = parseExportPayload(
      backupSkeleton([
        { date: '2026-10-04', habitId: 'water', done: true },
        { date: '2026-10-04', habitId: 'water', done: true },
      ]),
    );
    expect(dup.ok, '同日同名两行 = 日期|habitId 重复 → 备份不可恢复').toBe(false);
  });

  it('★ 真实 HTTP：与内置同名的习惯不再产生「同日同名」两行 → 导出文件恢复得回来', async () => {
    const builtin = await prisma.habitDefinition.findFirst({ where: { code: 'water', userId: null } });
    expect(builtin, '种子应包含内置 water 模板').not.toBeNull();

    // 复现 QA 的造数方式：直接用内置同名 code 建自建习惯
    const created = await createHabit('water', '我自己的喝水');
    expect(created.status, '创建必须成功 —— 不因 code 撞名而拦下用户').toBe(200);
    const custom = created.body.data as { id: number; code: string; name: string; isBuiltin: boolean };

    // 关键：落库的 code 已被收敛，不再与内置同名
    expect(custom.code, '落库 code 必须被收敛，不能与内置 water 同名').not.toBe('water');
    const row = await prisma.habitDefinition.findUnique({ where: { id: custom.id } });
    expect(row?.code).not.toBe('water');

    // 同一天两边都打卡 → 走一次真实导出，确认文件可被自己的解析器接受
    const day = toLocalDateKey(new Date());
    await checkin(builtin!.id, day);
    await checkin(custom.id, day);

    const payload = await exportAll();
    const rows = (payload.habits as Array<{ date: string; habitId: string }>).filter(
      (row) => row.date === day && row.habitId.startsWith('water'),
    );
    const keys = rows.map((row) => `${row.date}|${row.habitId}`);
    expect(new Set(keys).size, `导出出现重复的「日期|habitId」：${keys.join(' , ')}`).toBe(keys.length);

    const parsed = parseExportPayload(JSON.stringify(payload));
    expect(parsed.ok, '用户自己的导出文件必须能被恢复（这是本缺陷的实质危害）').toBe(true);
  });

  it('★ 真实 HTTP：导出的备份能走完「预览 + 恢复」两步', async () => {
    const payload = await exportAll();
    const preview = await request(server as never)
      .post(`${API}/data/restore/preview`)
      .set(auth())
      .send({ content: JSON.stringify(payload) })
      .expect(200);
    const previewToken = (preview.body.data as { previewToken: unknown }).previewToken;

    await request(server as never)
      .post(`${API}/data/restore`)
      .set(auth())
      .send({ previewToken })
      .expect(200);

    // 恢复后习惯仍在（打卡历史没有被恢复流程吃掉）
    const habits = await listHabits();
    expect(habits.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 处置口径：无负罪感 —— 名字照写、创建照常、不报错
// ---------------------------------------------------------------------------

describe('处置口径 · 温和放行（不拦用户）', () => {
  it('★ 与内置同名：200、名字原样保留、内置标记为 false、无任何错误字段', async () => {
    const res = await createHabit('early_sleep', '我自己想早点睡');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();

    const habit = res.body.data as { code: string; name: string; isBuiltin: boolean };
    // 用户写的名字一个字符都不能被改 —— 这是产品的正当需求，不是错误
    expect(habit.name).toBe('我自己想早点睡');
    expect(habit.isBuiltin).toBe(false);
    // code 被静默收敛，用户无感
    expect(habit.code).not.toBe('early_sleep');
  });

  it('同名自建习惯的第 2 次创建同样放行，且两条都真实存在（没有互相覆盖）', async () => {
    const first = await createHabit('dup_scope_probe', '第一个');
    const second = await createHabit('dup_scope_probe', '第二个');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const a = first.body.data as { id: number; code: string; name: string };
    const b = second.body.data as { id: number; code: string; name: string };
    expect(a.id, '两次创建必须是两条独立记录，不能互相顶掉').not.toBe(b.id);
    expect(a.code).not.toBe(b.code);
    expect(a.name).toBe('第一个');
    expect(b.name).toBe('第二个');

    // 两条都落库，且 code 在「内置 ∪ 本人」作用域内互不相同
    const rows = await prisma.habitDefinition.findMany({
      where: { userId, name: { in: ['第一个', '第二个'] } },
      select: { id: true, code: true },
    });
    expect(rows.length).toBe(2);
    expect(rows[0]!.code).not.toBe(rows[1]!.code);
  });

  it('无冲突时 code 原样保留（不无谓改写用户的标识）', async () => {
    const res = await createHabit('keep_my_own_code_1', '保留原样');
    expect(res.status).toBe(200);
    expect((res.body.data as { code: string }).code).toBe('keep_my_own_code_1');
  });

  it('收敛后的 code 仍然稳定可复现（同一个冲突 code 再建一次，后缀继续递增而非随机跳）', async () => {
    const a = await createHabit('stable_probe', '稳定一');
    const b = await createHabit('stable_probe', '稳定二');
    const c = await createHabit('stable_probe', '稳定三');
    const codes = [a, b, c].map((r) => (r.body.data as { code: string }).code);
    expect(new Set(codes).size, '三次创建的 code 必须互不相同').toBe(3);
    // 全部落在同一前缀下，说明是确定性派生而非随机
    for (const code of codes) expect(code.startsWith('stable_probe')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 列表口径：同名不再产生「看起来重复」的 code，但展示层仍需区分（留给 UI）
// ---------------------------------------------------------------------------

describe('列表口径 · code 唯一后 GET /habits 的可区分性', () => {
  it('★ 列表里任意两个习惯的 code 都不同（备份可恢复性的充要前提）', async () => {
    const habits = await listHabits();
    const codes = habits.map((habit) => habit.code as string);
    const duplicated = codes.filter((code, index) => codes.indexOf(code) !== index);
    expect(duplicated, `列表里仍有重复 code：${duplicated.join(', ')}`).toHaveLength(0);
  });

  it('列表同时包含内置与自建，且两者靠 isBuiltin 区分（展示层区分的数据基础）', async () => {
    const habits = await listHabits();
    expect(habits.some((habit) => habit.isBuiltin === true), '应含内置模板').toBe(true);
    expect(habits.some((habit) => habit.isBuiltin === false), '应含自建习惯').toBe(true);
  });
});
