/**
 * `POST /api/data/import/weights` 的**规模护栏**（2000 行到底安不安全？）。
 *
 * ### 为什么要有这个文件（本轮的教训，写下来防止将来重吵一遍）
 *
 * 曾经有人（就是我）断言「2000 行历史体重塞进**一条** `$transaction` 会触碰
 * Prisma 默认 5 秒事务超时（`P2028`）、整批回滚」—— 听起来很合理，于是加了分批、
 * 补偿事务、导入前快照。**实测证明这个失败模式在本项目里不可达**：
 *
 * - **数组形式 `prisma.$transaction([...])` 根本没有 5 秒超时**。Prisma 5.22 的
 *   5s / maxWait 只作用于**交互式** `$transaction(cb)`（运行时代码里也只有
 *   `_transactionWithCallback` 把 `timeout` 传给引擎，`_transactionWithArray`
 *   只取 `isolationLevel`）。实测绕开 DTO 上限直压：单事务 **8000 行 2354ms ok**、
 *   **20000 行 7845ms ok**，**均不抛 P2028** —— 跑 7.8 秒都不超时。
 * - **满额 2000 行单事务实测 ~600ms**（预置 500 行既有体重：500 覆盖 + 1500 新增）：
 *   纯 `$transaction` 582/571/571ms，走服务层 HTTP 墙钟 631/637/599ms。
 * - 分批版（每批 500 + 导入前快照 + 补偿事务）端到端反而**慢 15~25%**
 *   （705~792ms vs 599~637ms），因为它多付了一次快照读和 4 次 BEGIN/COMMIT。
 *
 * 结论：分批解决的失败模式不存在，已撤（revert 880fe05）。**留这个文件不是留分批，
 * 是留「别再有人凭直觉把 2000 行判成危险」的可执行证据。**
 *
 * ### 覆盖清单
 *
 * ① 满额载荷（`MAX_IMPORT_ROWS` 行）导入成功，`imported` 等于**传入行数** + 条数落库；
 * ② **耗时护栏**：满额导入 < 2500ms（实测 ~600ms，4 倍余量）—— 若哪天这条红了，
 *    先去看是不是有人把这条路径改成了「逐行往返」或加了全表扫描，而不是去加分批；
 * ③ **同日后者胜**（单次请求内）：同一日期出现两次、体重不同 → 库里是**后一条**的值
 *    （upsert 唯一键 `@@unique([userId, loggedAt])` 的领域契约，与分批无关）；
 * ④ 0 行**不开事务**（`$transaction([])` 是空操作，别白开一次）。
 */
import 'reflect-metadata';

import { createRequire } from 'node:module';

import type { INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { MAX_IMPORT_ROWS } = require('../dist/apps/api/src/data/dto/import-weights.dto.js') as {
  MAX_IMPORT_ROWS: number;
};

/**
 * 耗时护栏阈值（ms）。
 *
 * 实测基线（本机 SQLite，满额 2000 行 + 预置 500 行既有）：**约 600ms**
 * （HTTP 墙钟 599~637ms）。取 2500ms 是**约 4 倍余量**：既能抓住「改成逐行往返」
 * 这类数量级的退化（那时会是几十秒），又不至于被一次 CI 抖动误伤。
 * ⚠️ 若将来要调这个数，请**重跑一次基准**并把新的实测值写回本文件的头注释。
 */
const MAX_IMPORT_WALL_MS = 2500;

const API = '/api';
const USER = 'e2e-import-scale@qinglife.test';

/** 日期基准：2020-01-01 起往后数，2000 行落在 2025 年中，全是过去的日子。 */
const DATE_BASE_UTC = Date.UTC(2020, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

/** 第 `offsetDays` 天的 `YYYY-MM-DD`（与服务端 `toDateKey` 同口径的本地日期键）。 */
function dateKeyAt(offsetDays: number): string {
  return new Date(DATE_BASE_UTC + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

type TxFn = (...args: unknown[]) => Promise<unknown>;

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

/** 直接调批量导入接口。 */
async function importWeights(body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await request(server as never)
    .post(`${API}/data/import/weights`)
    .set(auth(token))
    .send(body as never);
  return { status: response.status, body: response.body };
}

/** 读出某一天的体重记录（不存在返回 null）。 */
async function weightAt(date: string): Promise<{ weightKg: number; note: string | null } | null> {
  const row = await prisma.weightLog.findUnique({
    where: { userId_loggedAt: { userId, loggedAt: date } },
  });
  return row === null ? null : { weightKg: row.weightKg, note: row.note };
}

/** 该用户当前的体重总条数。 */
function weightCount(): Promise<number> {
  return prisma.weightLog.count({ where: { userId } });
}

/**
 * 装一个 `prisma.$transaction` 的 spy（**保留原实现**，只记录调用）。
 *
 * ⚠️ `original` 必须在 spy 之前取，否则会把 spy 自己绑进去造成无限递归。
 */
function installTransactionSpy() {
  const original = prisma.$transaction.bind(prisma) as unknown as TxFn;
  const target = prisma as unknown as { $transaction: TxFn };
  const spy = vi.spyOn(target, '$transaction');
  // 显式挂回原实现：不依赖「spy 默认走原实现」的隐式行为，语义更直白。
  spy.mockImplementation(original);
  return spy;
}

/** 构造 `count` 行互不相同的合法体重数据。 */
function buildRows(count: number): Array<{ date: string; weightKg: number; note?: string }> {
  return Array.from({ length: count }, (_, index) => ({
    date: dateKeyAt(index),
    weightKg: 60 + (index % 30) * 0.1,
  }));
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
});

afterEach(() => {
  // 每个用例结束都还原，避免 spy 泄漏到下一个用例。
  vi.restoreAllMocks();
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

describe('体重批量导入 · 规模护栏', () => {
  it('① 满额载荷（MAX_IMPORT_ROWS 行）导入成功，imported 等于传入行数', async () => {
    // 断契约：用接口允许的最大行数，不写死 2000 —— DTO 上限改了这里跟着变。
    const rows = buildRows(MAX_IMPORT_ROWS);

    const { status, body } = await importWeights({ rows });

    expect(status).toBe(200);
    const data = (body as { data: { imported: number; skipped: number; errors: unknown[] } }).data;
    expect(data.imported).toBe(rows.length);
    expect(data.skipped).toBe(0);
    expect(data.errors).toEqual([]);

    // 行都落库（日期互不相同 → 条数等于行数）
    expect(await weightCount()).toBe(rows.length);
  });

  it('② 耗时护栏：满额导入远快于事务超时阈值（实测 ~600ms，阈值 2500ms）', async () => {
    // 预置 500 行既有体重，贴近真实：2000 行 = 500 覆盖 + 1500 新增
    await prisma.weightLog.createMany({
      data: Array.from({ length: 500 }, (_, index) => ({
        userId,
        loggedAt: dateKeyAt(index),
        weightKg: 70 + (index % 50) * 0.1,
        source: 'manual',
      })),
    });

    const rows = buildRows(MAX_IMPORT_ROWS);
    const startedAt = Date.now();
    const { status } = await importWeights({ rows });
    const elapsedMs = Date.now() - startedAt;

    expect(status).toBe(200);
    // 不是精确计时断言，是「别退化一个数量级」的护栏：基线 ~600ms，阈值 2500ms。
    expect(elapsedMs).toBeLessThan(MAX_IMPORT_WALL_MS);
  });

  it('③ 同日后者胜：单次请求内同一日期出现两次，库里是后一条的值', async () => {
    const rows = buildRows(50);
    const sameDate = rows[0]!.date;
    rows[rows.length - 1] = { date: sameDate, weightKg: 88.8, note: '后一条' };

    const { status, body } = await importWeights({ rows });
    expect(status).toBe(200);
    // 同日的两条都算「导入了」（imported 数的是传入行，不是去重后的日期数）
    expect((body as { data: { imported: number } }).data.imported).toBe(rows.length);

    // 同日只留一条，且是**后一条**的值（upsert 唯一键 [userId, loggedAt]）
    expect(await weightCount()).toBe(rows.length - 1);
    expect(await weightAt(sameDate)).toEqual({ weightKg: 88.8, note: '后一条' });
  });

  it('④ 0 行不开事务（$transaction([]) 是空操作，别白开一次）', async () => {
    const spy = installTransactionSpy();

    const { status, body } = await importWeights({ rows: [] });
    expect(status).toBe(200);
    expect((body as { data: { imported: number } }).data.imported).toBe(0);

    expect(spy).not.toHaveBeenCalled();
  });
});
