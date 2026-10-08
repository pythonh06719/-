/**
 * 非法日期键防御 + 周报习惯口径对齐（缺陷注入反验）。
 *
 * 本文件钉住三个缺陷，每个用例都写成「**改代码前必须是红的**」：
 *
 * 🔴 缺陷 1：`POST /api/weights` 传 `loggedAt: "2026-02-31"`（正则满足、但**日历上不存在**）
 *   → 修复前**200 入库**（`WeightLog.loggedAt` 是 `String`，Prisma 不做日期语义校验）
 *   → 那个点会进入趋势图、污染 7 日均线、让周报体重变化量算错，且**无自愈路径**。
 *   修法：17 处裸 `@Matches(LOCAL_DATE_PATTERN_STRICT)` 换成 `@IsLocalDateKey`（严格 + 回环）。
 *
 * 🔴 缺陷 2：`POST /api/data/import/weights` 的 `rows` 分支用裸正则判日期，
 *   与 `csvText` 分支（core 的 `isLocalDateKey`）**结论相反**。
 *   修法：`DataService.isValidRow` 改用 `isLocalDateKey`，两条分支口径一致。
 *
 * 🔴 缺陷 3：`GET /api/report/weekly` 的习惯达成率**分子分母口径不一致** ——
 *   分母 `habitsTotal` 过滤 `isActive: true`，分子 `habitsDone` 不过滤。
 *   叠加「停用只切 `isActive`、打卡记录完全不动」的刻意设计后，
 *   停用 1 个习惯 → `habitsDone(3) > habitsTotal(2)`。
 *   修法：`checked` 查询补上与分母同一份习惯 id 集合的过滤。
 */
import 'reflect-metadata';

import { createRequire } from 'node:module';

import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AppModule as AppModuleClass } from '../src/app.module';
import type { PrismaService as PrismaServiceClass } from '../src/prisma/prisma.service';

const require = createRequire(import.meta.url);
const { Test } = require('@nestjs/testing') as typeof import('@nestjs/testing');
const request = require('supertest') as unknown as typeof import('supertest');
const { AppModule } = require('../dist/apps/api/src/app.module.js') as {
  AppModule: typeof AppModuleClass;
};
const { PrismaService } = require('../dist/apps/api/src/prisma/prisma.service.js') as {
  PrismaService: typeof PrismaServiceClass;
};

const API = '/api';
const USER = 'e2e-datekey-guard@qinglife.test';

/**
 * 各类「形状合法但日历上不存在」的日期。
 * 它们都满足 `^\d{4}-\d{2}-\d{2}$`，所以裸 `@Matches` 全部放行。
 */
const IMPOSSIBLE_DATES = [
  '2026-02-31', // 2 月没有 31 日
  '2026-13-01', // 13 月
  '2026-00-10', // 0 月
  '2026-04-31', // 4 月只有 30 天
  '2025-02-29', // 2025 不是闰年
];

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let token = '';
let userId = 0;

function auth(value: string): { Authorization: string } {
  return { Authorization: `Bearer ${value}` };
}

async function login(email: string): Promise<string> {
  const sent = await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  const code = (sent.body.data as { code?: string }).code;
  if (typeof code !== 'string') {
    throw new Error(`未取到 ${email} 的验证码回显`);
  }
  const verified = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email, code })
    .expect(200);
  return (verified.body.data as { accessToken: string }).accessToken;
}

/** 本地今天（避免 UTC 日错位，与被测代码同口径）。 */
function todayKey(): string {
  const now = new Date();
  const pad = (v: number): string => (v < 10 ? `0${v}` : String(v));
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function shiftDays(dateKey: string, delta: number): string {
  const date = new Date(
    Number(dateKey.slice(0, 4)),
    Number(dateKey.slice(5, 7)) - 1,
    Number(dateKey.slice(8, 10)),
  );
  date.setDate(date.getDate() + delta);
  const pad = (v: number): string => (v < 10 ? `0${v}` : String(v));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

beforeAll(async () => {
  process.env.AUTH_LOG_CODE = 'true';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  server = app.getHttpServer();
  prisma = moduleRef.get<PrismaServiceClass>(PrismaService);

  await prisma.authVerificationCode.deleteMany({ where: { email: USER } });
  await prisma.user.deleteMany({ where: { email: USER } });
  token = await login(USER);
  userId = (await prisma.user.findUniqueOrThrow({ where: { email: USER } })).id;
});

beforeEach(async () => {
  await prisma.weightLog.deleteMany({ where: { userId } });
  await prisma.habitCheckin.deleteMany({ where: { userId } });
  await prisma.habitDefinition.deleteMany({ where: { userId } });
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.authVerificationCode.deleteMany({ where: { email: USER } });
    await prisma.user.deleteMany({ where: { email: USER } });
  }
  if (app !== undefined) {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 🔴 缺陷 1：写接口的日期只验形状不验真实性
// ---------------------------------------------------------------------------

describe('🔴 缺陷 1 · 非法日期键不得进数据库', () => {
  it('POST /api/weights 传 2026-02-31 → 400，且不落库', async () => {
    const response = await request(server as never)
      .post(`${API}/weights`)
      .set(auth(token))
      .send({ loggedAt: '2026-02-31', weightKg: 60 })
      .then((r: { status: number }) => r.status);

    expect(response).toBe(400);
    // 关键：不只看状态码，还要确认**真的没写进去**（Prisma 对 String 列不做日期校验）
    const row = await prisma.weightLog.findFirst({
      where: { userId, loggedAt: '2026-02-31' },
    });
    expect(row).toBeNull();
  });

  it('POST /api/weights 全部「形状合法但不存在的日期」都被拒（逐个反验）', async () => {
    for (const bad of IMPOSSIBLE_DATES) {
      const response = await request(server as never)
        .post(`${API}/weights`)
        .set(auth(token))
        .send({ loggedAt: bad, weightKg: 60 })
        .then((r: { status: number }) => r.status);
      expect(response, `${bad} 应被拒`).toBe(400);
    }
    const total = await prisma.weightLog.count({ where: { userId } });
    expect(total).toBe(0);
  });

  it('合法日期（含闰年 2-29 与 12-31）仍然放行 —— 不误伤', async () => {
    for (const good of ['2024-02-29', '2026-12-31', '2026-01-01']) {
      const response = await request(server as never)
        .post(`${API}/weights`)
        .set(auth(token))
        .send({ loggedAt: good, weightKg: 60 })
        .then((r: { status: number }) => r.status);
      expect(response, `${good} 应放行`).toBe(200);
    }
    expect(await prisma.weightLog.count({ where: { userId } })).toBe(3);
  });

  it('POST /api/meals 传非法日期 → 400', async () => {
    const response = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(token))
      .send({ loggedDate: '2026-02-31', mealType: 'breakfast', customName: '粥', kcal: 100 })
      .then((r: { status: number }) => r.status);
    expect(response).toBe(400);
  });

  it('POST /api/water 传非法日期 → 400', async () => {
    const response = await request(server as never)
      .post(`${API}/water`)
      .set(auth(token))
      .send({ loggedDate: '2026-02-31', amountMl: 250 })
      .then((r: { status: number }) => r.status);
    expect(response).toBe(400);
  });

  it('POST /api/exercises 传非法日期 → 400', async () => {
    const response = await request(server as never)
      .post(`${API}/exercises`)
      .set(auth(token))
      .send({ loggedDate: '2026-02-31', activityCode: 'walking_brisk', minutes: 30 })
      .then((r: { status: number }) => r.status);
    expect(response).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 🔴 缺陷 2：import/weights 的两条分支对坏数据结论相反
// ---------------------------------------------------------------------------

describe('🔴 缺陷 2 · rows 分支与 csvText 分支口径必须一致', () => {
  it('rows 分支：不存在的日期应被跳过（计入 skipped），不入库', async () => {
    const response = await request(server as never)
      .post(`${API}/data/import/weights`)
      .set(auth(token))
      .send({
        rows: [
          { date: '2026-07-01', weightKg: 65 },
          { date: '2026-02-31', weightKg: 66 }, // 不存在
          { date: '2026-07-03', weightKg: 64.8 },
        ],
      })
      .then((r: { status: number; body: unknown }) => ({
        status: r.status,
        data: (r.body as { data: { imported: number; skipped: number; errors: Array<{ row: number; reason: string }> } }).data,
      }));

    expect(response.status).toBe(200);
    expect(response.data.imported).toBe(2);
    expect(response.data.skipped).toBe(1);
    expect(response.data.errors).toHaveLength(1);
    expect(response.data.errors[0]?.row).toBe(3);

    // 关键断言：坏日期**没有**落库
    const bad = await prisma.weightLog.findFirst({
      where: { userId, loggedAt: '2026-02-31' },
    });
    expect(bad).toBeNull();
    expect(await prisma.weightLog.count({ where: { userId } })).toBe(2);
  });

  it('两条分支对同一个坏日期给出**相同结论**（口径一致的核心证据）', async () => {
    const viaRows = await request(server as never)
      .post(`${API}/data/import/weights`)
      .set(auth(token))
      .send({ rows: [{ date: '2026-02-31', weightKg: 66 }] })
      .then((r: { body: unknown }) => (r.body as { data: { imported: number; skipped: number } }).data);

    const viaCsv = await request(server as never)
      .post(`${API}/data/import/weights`)
      .set(auth(token))
      .send({ csvText: 'date,weightKg\n2026-02-31,66\n' })
      .then((r: { body: unknown }) => (r.body as { data: { imported: number; skipped: number } }).data);

    expect(viaRows.imported).toBe(viaCsv.imported);
    expect(viaRows.skipped).toBe(viaCsv.skipped);
    expect(await prisma.weightLog.count({ where: { userId } })).toBe(0);
  });

  it('rows 分支：13 月 / 0 月 / 平年 2-29 也都要被跳过', async () => {
    const data = await request(server as never)
      .post(`${API}/data/import/weights`)
      .set(auth(token))
      .send({
        rows: [
          { date: '2026-13-01', weightKg: 66 },
          { date: '2026-00-10', weightKg: 66 },
          { date: '2025-02-29', weightKg: 66 },
        ],
      })
      .then((r: { body: unknown }) => (r.body as { data: { imported: number; skipped: number } }).data);

    expect(data.imported).toBe(0);
    expect(data.skipped).toBe(3);
    expect(await prisma.weightLog.count({ where: { userId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 🔴 缺陷 3：周报习惯达成率分子分母口径不一致
// ---------------------------------------------------------------------------

/**
 * 读周报某天的习惯计数。
 *
 * ⚠️ **为什么用「基线差值」而不是绝对值**：本测试跑在**共享 dev.db** 上，
 * 其中已被 `db:seed` 播了 6 个**内置习惯**（`userId = null`）。而 `habitsTotal`
 * 按 `OR: [{ userId }, { userId: null }]` 统计 —— 内置习惯**任何用户都算进去**。
 * 若直接断言 `habitsTotal === 2`，一旦 seed 里的内置习惯数变化就会假红。
 * 故先读一份「什么都没建时」的基线，再断言**增量**，使用例只受本用例行为影响。
 */
async function weeklyHabitRow(date: string): Promise<{ habitsDone: number; habitsTotal: number }> {
  const report = await request(server as never)
    .get(`${API}/report/weekly`)
    .set(auth(token))
    .expect(200);
  const data = (report.body as {
    data: { days: Array<{ date: string; habitsDone: number; habitsTotal: number }> };
  }).data;
  const row = data.days.find((d) => d.date === date);
  expect(row, `周报应包含 ${date} 这一行`).toBeDefined();
  return { habitsDone: row!.habitsDone, habitsTotal: row!.habitsTotal };
}

/** 建一个自建习惯并打卡（今天），返回习惯 id。 */
async function createCheckedHabit(code: string, name: string, date: string): Promise<number> {
  const created = await request(server as never)
    .post(`${API}/habits`)
    .set(auth(token))
    .send({ code, name })
    .expect(200);
  const id = (created.body as { data: { id: number } }).data.id;
  await request(server as never)
    .post(`${API}/habits/${id}/check`)
    .set(auth(token))
    .send({ loggedDate: date, done: true })
    .expect(200);
  return id;
}

describe('🔴 缺陷 3 · 周报习惯达成率：停用后 habitsDone 不得 > habitsTotal', () => {
  it('停用 1 个习惯后，增量口径下 habitsDone ≤ habitsTotal（核心反验）', async () => {
    const today = todayKey();
    const before = await weeklyHabitRow(today);

    // 建 3 个自建习惯并全部打卡
    const ids: number[] = [];
    for (const name of ['喝水', '早睡', '走路']) {
      ids.push(await createCheckedHabit(`t_${name}`, name, today));
    }
    const all = await weeklyHabitRow(today);
    expect(all.habitsTotal - before.habitsTotal).toBe(3);
    expect(all.habitsDone - before.habitsDone).toBe(3);

    // 停用第 3 个（只切 isActive，打卡记录保留 —— 这是刻意设计）
    await request(server as never)
      .patch(`${API}/habits/${ids[2]!}`)
      .set(auth(token))
      .send({ isActive: false })
      .expect(200);

    // 打卡行确实还在（证明「停用不清历史」这条设计没被破坏）
    expect(
      await prisma.habitCheckin.count({ where: { userId, habitId: ids[2]!, done: true } }),
    ).toBe(1);

    const after = await weeklyHabitRow(today);

    // 分母确实因停用而 -1（证明停用生效、测试前提成立）
    expect(all.habitsTotal - after.habitsTotal).toBe(1);

    // 🔴 核心断言：分子不得超过分母。
    // 修复前：分母 -1 而分子不变 → 增量口径下 done(3) > total(2)。
    expect(after.habitsDone).toBeLessThanOrEqual(after.habitsTotal);
    expect(after.habitsDone).toBe(2);
    expect(after.habitsTotal).toBe(all.habitsTotal - 1);
  });

  it('未停用时增量口径 habitsDone 仍等于 habitsTotal（不因修复而漏算）', async () => {
    const today = todayKey();
    const before = await weeklyHabitRow(today);

    await createCheckedHabit('keep_a', '喝水A', today);
    await createCheckedHabit('keep_b', '早睡B', today);

    const after = await weeklyHabitRow(today);
    // 只断言**增量**相等：绝对值里含 6 个未打卡的内置习惯，done 必然小于 total，
    // 那是正确的（内置习惯今天没打卡）。要防的是「修复把本该计入的打卡漏掉」。
    expect(after.habitsTotal - before.habitsTotal).toBe(2);
    expect(after.habitsDone - before.habitsDone).toBe(2);
  });

  it('全部停用后，今日分子必须为 0（不能出现「停用习惯仍被计入分子」的 1/0）', async () => {
    const today = todayKey();
    const ids = [await createCheckedHabit('gone_a', '待停用A', today)];
    ids.push(await createCheckedHabit('gone_b', '待停用B', today));

    // 两条都停用 —— 分母增量应归 0
    for (const id of ids) {
      await request(server as never)
        .patch(`${API}/habits/${id}`)
        .set(auth(token))
        .send({ isActive: false })
        .expect(200);
    }

    // 打卡行仍在（刻意设计），但**不应再进入周报统计**
    const kept = await prisma.habitCheckin.count({ where: { userId, done: true } });
    expect(kept).toBeGreaterThan(0);

    const row = await weeklyHabitRow(today);
    // 分子不得为正（这两条打卡属于已停用习惯）
    expect(row.habitsDone).toBe(0);
  });
});
