/**
 * QA 独立证伪（software-qa-engineer-4）—— bcd4af4 的 **P0-2/3/4 + P1-6**。
 *
 * 覆盖：
 * - **B5** reorder 并发（读-算-写事务）
 * - **B6** nextSortOrder 并发（create 撞号）
 * - **C7** 非法日期（period / weekly 的 endDate）
 * - **C8** reorder 越权 / 不存在 id 的「同码同文案」oracle 消除
 *
 * 与既有 e2e 同机制：加载 `dist/**`（tsc 产物，带装饰器元数据）。运行前必须 `npm run build -w @qsh/api`。
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

const { toLocalDateKey } = core;

const API = '/api';
const USER_A = 'qa-bcd4af4-a@qinglife.test';
const USER_B = 'qa-bcd4af4-b@qinglife.test';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let tokenA = '';
let tokenB = '';

const today = toLocalDateKey(new Date());

function shiftDays(from: string, delta: number): string {
  const [year, month, day] = from.slice(0, 10).split('-').map((part) => Number(part));
  const date = new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() + delta);
  return toLocalDateKey(date);
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function login(email: string): Promise<string> {
  const sent = await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  const code = (sent.body.data as { code?: string }).code;
  if (typeof code !== 'string') throw new Error(`未取到 ${email} 的验证码回显`);
  const verified = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email, code })
    .expect(200);
  return (verified.body.data as { accessToken: string }).accessToken;
}

async function createMeal(
  token: string,
  input: { loggedDate: string; mealType: string; customName: string; customKcal?: number },
): Promise<number> {
  const res = await request(server as never)
    .post(`${API}/meals`)
    .set(auth(token))
    .send({
      loggedDate: input.loggedDate,
      mealType: input.mealType,
      customName: input.customName,
      customKcal: input.customKcal ?? 100,
    })
    .expect(200);
  expect(res.body.error).toBeNull();
  return (res.body.data.entry as { id: number }).id;
}

type LogRow = { id: number; customName: string | null; sortOrder: number; mealType: string };

async function logsOf(token: string, date: string, mealType: string): Promise<LogRow[]> {
  const res = await request(server as never).get(`${API}/meals`).query({ date }).set(auth(token)).expect(200);
  const groups = (res.body.data as { groups: Array<{ mealType: string; logs: LogRow[] }> }).groups;
  return groups.find((group) => group.mealType === mealType)?.logs ?? [];
}

async function allLogs(token: string, date: string): Promise<LogRow[]> {
  const res = await request(server as never).get(`${API}/meals`).query({ date }).set(auth(token)).expect(200);
  const groups = (res.body.data as { groups: Array<{ logs: LogRow[] }> }).groups;
  return groups.flatMap((group) => group.logs);
}

function reorder(
  token: string,
  body: { loggedDate: string; mealType: string; orderedIds: number[] },
): Promise<{ status: number; body: any }> {
  return request(server as never)
    .patch(`${API}/meals/reorder`)
    .set(auth(token))
    .send(body)
    .then((res) => ({ status: res.status, body: res.body }));
}

beforeAll(async () => {
  process.env.AUTH_LOG_CODE = 'true';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  server = app.getHttpServer();
  prisma = moduleRef.get<PrismaServiceClass>(PrismaService);

  await prisma.authVerificationCode.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
  await prisma.user.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
  tokenA = await login(USER_A);
  tokenB = await login(USER_B);
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.authVerificationCode.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
    await prisma.user.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
  }
  if (app !== undefined) await app.close();
});

describe('B6 · nextSortOrder 并发（create 撞号，QA 独立）', () => {
  it('同用户·同日·同餐并发新增 6 条 → sortOrder 恰为 0..5，无重复', async () => {
    const date = shiftDays(today, -60);
    const N = 6;
    const responses = await Promise.all(
      Array.from({ length: N }, (_, index) =>
        request(server as never)
          .post(`${API}/meals`)
          .set(auth(tokenA))
          .send({ loggedDate: date, mealType: 'dinner', customName: `QA-B6-${index}`, customKcal: 100 }),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
    }
    const logs = await logsOf(tokenA, date, 'dinner');
    const sortOrders = logs.map((log) => log.sortOrder).sort((left, right) => left - right);
    expect(logs).toHaveLength(N);
    expect(new Set(sortOrders).size).toBe(N); // 无撞号
    expect(sortOrders).toEqual(Array.from({ length: N }, (_, index) => index));
  });

  it('并发新增 + 并发 quickAdd 混投同一餐 → 仍无重复、无空洞', async () => {
    const date = shiftDays(today, -61);
    const reqs = [
      request(server as never).post(`${API}/meals`).set(auth(tokenA)).send({ loggedDate: date, mealType: 'snack', customName: 'QA-B6-mix-0', customKcal: 80 }),
      request(server as never).post(`${API}/meals/quick-add`).set(auth(tokenA)).send({ loggedDate: date, mealType: 'snack', customName: 'QA-B6-mix-1', customKcal: 80 }),
      request(server as never).post(`${API}/meals`).set(auth(tokenA)).send({ loggedDate: date, mealType: 'snack', customName: 'QA-B6-mix-2', customKcal: 80 }),
      request(server as never).post(`${API}/meals/quick-add`).set(auth(tokenA)).send({ loggedDate: date, mealType: 'snack', customName: 'QA-B6-mix-3', customKcal: 80 }),
    ];
    const responses = await Promise.all(reqs);
    for (const res of responses) expect(res.status).toBe(200);
    const logs = await logsOf(tokenA, date, 'snack');
    const sortOrders = logs.map((log) => log.sortOrder).sort((left, right) => left - right);
    expect(sortOrders).toEqual([0, 1, 2, 3]);
  });
});

describe('B5 · reorder 并发（读-算-写事务，QA 独立）', () => {
  it('三个各自独立的源餐并发移到同一空餐 → 无行丢失、每餐 0..n-1 无重复', async () => {
    const date = shiftDays(today, -62);
    const a = await createMeal(tokenA, { loggedDate: date, mealType: 'breakfast', customName: 'QA-B5-a' });
    const d = await createMeal(tokenA, { loggedDate: date, mealType: 'dinner', customName: 'QA-B5-d' });
    const l = await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'QA-B5-l' });

    const responses = await Promise.all([
      reorder(tokenA, { loggedDate: date, mealType: 'snack', orderedIds: [a] }),
      reorder(tokenA, { loggedDate: date, mealType: 'snack', orderedIds: [d] }),
      reorder(tokenA, { loggedDate: date, mealType: 'snack', orderedIds: [l] }),
    ]);
    expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);

    const all = await allLogs(tokenA, date);
    expect(new Set(all.map((log) => log.id))).toEqual(new Set([a, d, l]));
    const byMeal = new Map<string, number[]>();
    for (const log of all) byMeal.set(log.mealType, [...(byMeal.get(log.mealType) ?? []), log.sortOrder]);
    for (const sortOrders of byMeal.values()) {
      const sorted = [...sortOrders].sort((left, right) => left - right);
      expect(sorted).toEqual(sorted.map((_, index) => index));
    }
  });

  it('同一餐并发提交两个不同顺序 → 最终仍是干净的 0..2 排列（不撕裂）', async () => {
    const date = shiftDays(today, -63);
    const a = await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'QA-B5same-a' });
    const b = await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'QA-B5same-b' });
    const c = await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'QA-B5same-c' });
    expect((await logsOf(tokenA, date, 'lunch')).map((log) => log.sortOrder)).toEqual([0, 1, 2]);

    const responses = await Promise.all([
      reorder(tokenA, { loggedDate: date, mealType: 'lunch', orderedIds: [c, b, a] }),
      reorder(tokenA, { loggedDate: date, mealType: 'lunch', orderedIds: [b, a, c] }),
    ]);
    expect(responses.map((res) => res.status)).toEqual([200, 200]);

    const logs = await logsOf(tokenA, date, 'lunch');
    // ① 三条一个不少
    expect(new Set(logs.map((log) => log.id))).toEqual(new Set([a, b, c]));
    // ② sortOrder 恰好是 {0,1,2}（无重复、无空洞）—— 撕裂状态会出现重复值
    const sortOrders = logs.map((log) => log.sortOrder).sort((left, right) => left - right);
    expect(sortOrders).toEqual([0, 1, 2]);
    // ③ 最终顺序必须是**某一个请求的完整顺序**（串行化后 last-writer-wins），
    //    不能是两次读-算-写交错产生的「混合体」
    const finalOrder = logs.map((log) => log.id);
    const allowed = [
      [c, b, a].join(','),
      [b, a, c].join(','),
    ];
    expect(allowed).toContain(finalOrder.join(','));
  });
});

describe('C7 · 非法日期（period / weekly endDate，QA 独立）', () => {
  it('period：endDate=2026-02-31 / 2026-13-01 / garbage → 400（不静默进位）', async () => {
    for (const bad of ['2026-02-31', '2026-13-01', '2026-04-31', 'garbage', '2026-2-3']) {
      const res = await request(server as never)
        .get(`${API}/report/period`)
        .query({ days: 30, endDate: bad })
        .set(auth(tokenA));
      expect(res.status, `period endDate=${bad}`).toBe(400);
      expect(res.body.error.code).toBe('E_VALID_INPUT');
      expect(res.body.error.fields.endDate).toBeDefined();
    }
  });

  it('period：endDate=2026-02-28 → 200', async () => {
    await request(server as never)
      .get(`${API}/report/period`)
      .query({ days: 30, endDate: '2026-02-28' })
      .set(auth(tokenA))
      .expect(200);
  });

  it('weekly：endDate=garbage / 2026-02-31 → 400（不再返回 from: NaN-NaN-NaN）', async () => {
    for (const bad of ['garbage', '2026-02-31', '2026-13-01']) {
      const res = await request(server as never)
        .get(`${API}/report/weekly`)
        .query({ endDate: bad })
        .set(auth(tokenA));
      expect(res.status, `weekly endDate=${bad}`).toBe(400);
      expect(res.body.error.code).toBe('E_VALID_INPUT');
      // 明确：不得以 200 返回带 NaN 的区间
      expect(JSON.stringify(res.body.data ?? {})).not.toContain('NaN');
    }
  });

  it('weekly：endDate 合法 2026-02-28 → 200，且区间无 NaN', async () => {
    const res = await request(server as never)
      .get(`${API}/report/weekly`)
      .query({ endDate: '2026-02-28' })
      .set(auth(tokenA))
      .expect(200);
    expect(JSON.stringify(res.body.data)).not.toContain('NaN');
  });
});

describe('C8 · reorder 越权 oracle（QA 独立）', () => {
  it('他人 id 与不存在 id → 完全相同的 status+code+message+fields；本人但不在该日 → 400', async () => {
    const date = shiftDays(today, -64);
    const mine = await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'QA-C8-他人' });

    // tokenB 探测 tokenA 的 id（同一天）
    const foreign = await reorder(tokenB, { loggedDate: date, mealType: 'lunch', orderedIds: [mine] });
    // tokenB 探测一个根本不存在的 id
    const absent = await reorder(tokenB, { loggedDate: date, mealType: 'lunch', orderedIds: [987654321] });

    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(foreign.body.error.code).toBe('E_NOTFOUND_MEAL');
    expect(absent.body.error.code).toBe(foreign.body.error.code);
    expect(absent.body.error.message).toBe(foreign.body.error.message);
    expect(absent.body.error.fields).toEqual(foreign.body.error.fields);

    // 本人但不在这一天 → 400 E_VALID_INPUT（仅泄露自己的数据）
    const otherDay = shiftDays(today, -65);
    const own = await createMeal(tokenB, { loggedDate: otherDay, mealType: 'lunch', customName: 'QA-C8-本人他日' });
    const notThisDay = await reorder(tokenB, { loggedDate: date, mealType: 'lunch', orderedIds: [own] });
    expect(notThisDay.status).toBe(400);
    expect(notThisDay.body.error.code).toBe('E_VALID_INPUT');
  });

  it('混合：他人 id + 不存在 id 一起 → 仍归为同一个 404（不因混合而改变）', async () => {
    const date = shiftDays(today, -66);
    const theirId = await createMeal(tokenA, { loggedDate: date, mealType: 'dinner', customName: 'QA-C8-混-a' });
    const res = await reorder(tokenB, { loggedDate: date, mealType: 'dinner', orderedIds: [theirId, 999888777] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_MEAL');
    expect(res.body.error.fields).toBeUndefined();
  });
});
