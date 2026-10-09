/**
 * `POST /api/data/import/weights` 的**分批护栏**（规模缺陷：行数一多整批失败）。
 *
 * ### 为什么必须有这个文件
 *
 * 历史实现把 N 条 upsert **全塞进一条 `$transaction`**（`DataService.importWeights`）。
 * 数据库是 SQLite（单写者），N 条写在同一事务里会长期独占写锁，而 Prisma 事务
 * 默认 **5 秒超时**（`P2028`）：2000 行（= `MAX_IMPORT_ROWS` 上限，约 5 年逐日记录，
 * 自用场景完全可能）几乎必然超时，结果是**整批回滚、一行都没进去**。
 * 这个缺陷**只在规模化时暴露** —— 3 行的用例永远绿，所以必须专门写一个大规模用例。
 *
 * ### 覆盖清单
 *
 * ① 2000 行（接口能收到的最大载荷）导入成功，`imported` 等于**传入行数**
 *    （断契约，不写死数字）；
 * ② **断言分批确实发生**（本文件的核心护栏）：spy `prisma.$transaction`，
 *    调用次数 === `Math.ceil(N / WEIGHT_IMPORT_BATCH_SIZE)`、每次入参数组长度 ≤ 批大小、
 *    各批长度之和 === N。**去掉分批（恢复单事务）时这条必须红**；
 * ③ **同日覆盖跨批仍是「后者胜」**：同一日期的两条记录被切进**不同批次**，
 *    断言库里是后一条的值 —— 这条能抓出分批引入的「顺序错乱」新缺陷；
 * ④ 0 行**不开事务**（`$transaction([])` 是空操作，别白开一次）；
 * ⑤ **失败语义 = 全或无**：注入「第 2 批事务失败」，断言接口 500、
 *    第 1 批已写入的行被**回滚掉**、导入前已有的旧值被**还原**。
 *
 * ### ⚠️ 为什么②必须 spy 真实调用，而不是断言结果
 *
 * 只断言「2000 行导入成功」在**未分批**的实现上也可能绿（只要事务没超时就过得去），
 * 那样这条护栏等于不存在。②直接钉住**事务的个数与大小**，是不分批改法绕不过去的断言。
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
const { WEIGHT_IMPORT_BATCH_SIZE } = require('../dist/apps/api/src/data/weight-import.constants.js') as {
  WEIGHT_IMPORT_BATCH_SIZE: number;
};

const API = '/api';
const USER = 'e2e-import-batch@qinglife.test';

/** 日期基准：2020-01-01 起往后数，2000 行落在 2025 年中，全是过去的日子。 */
const DATE_BASE_UTC = Date.UTC(2020, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

/** 第 `offsetDays` 天的 `YYYY-MM-DD`（与服务端 `toDateKey` 同口径的本地日期键）。 */
function dateKeyAt(offsetDays: number): string {
  return new Date(DATE_BASE_UTC + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

type TxArgs = unknown[];
type TxFn = (...args: TxArgs) => Promise<unknown>;

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

/** 取出 spy 记录的每次 `$transaction` 入参（数组的才是批量事务）。 */
function batchSizesOf(spy: { mock: { calls: unknown[][] } }): number[] {
  return spy.mock.calls.map((args) => {
    const arg = args[0];
    if (!Array.isArray(arg)) {
      throw new Error(`期望传入数组形式的批量事务，实际是 ${typeof arg}`);
    }
    return arg.length;
  });
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
  // 每个用例结束都还原，避免注入的失败实现泄漏到下一个用例。
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

describe('体重批量导入 · 分批护栏', () => {
  it('① 最大载荷（MAX_IMPORT_ROWS 行）导入成功，imported 等于传入行数', async () => {
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

  it('② 分批确实发生：事务个数 === ceil(N/批大小)，且每批 ≤ 批大小', async () => {
    const rows = buildRows(MAX_IMPORT_ROWS);
    const spy = installTransactionSpy();

    const { status } = await importWeights({ rows });
    expect(status).toBe(200);

    const expectedBatches = Math.ceil(rows.length / WEIGHT_IMPORT_BATCH_SIZE);
    const sizes = batchSizesOf(spy);

    // 关键护栏：不分批时这里只会是 1 次（且长度 = N > 批大小）→ 必红
    expect(sizes).toHaveLength(expectedBatches);
    for (const size of sizes) {
      expect(size).toBeLessThanOrEqual(WEIGHT_IMPORT_BATCH_SIZE);
    }
    // 一批不多、一条不少
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(rows.length);
  });

  it('③ 同日覆盖跨批仍是「后者胜」：首行与末行同日，末行在第 2 批', async () => {
    // 故意让 N = 批大小 + 1：首行落在第 1 批、末行落在第 2 批，
    // 同一日期的两条记录被**切到不同批次** —— 分批若打乱顺序，这条会红。
    const rows = buildRows(WEIGHT_IMPORT_BATCH_SIZE + 1);
    const sameDate = rows[0]!.date;
    const later = { date: sameDate, weightKg: 88.8, note: '后一条' };
    rows[rows.length - 1] = later;

    const { status, body } = await importWeights({ rows });
    expect(status).toBe(200);
    expect((body as { data: { imported: number } }).data.imported).toBe(rows.length);

    // 同日只留一条，且是**后一条**的值（跨批也要后者胜）
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

  it('⑤ 中途某批失败 → 全或无：接口 500，已写入的批被回滚、旧值被还原', async () => {
    const rows = buildRows(WEIGHT_IMPORT_BATCH_SIZE + 1);
    const seedDate = rows[0]!.date;
    // 导入前就存在的一条旧记录，它会被本次导入覆盖 —— 失败时必须还原成这个值
    await prisma.weightLog.create({
      data: { userId, loggedAt: seedDate, weightKg: 71.4, note: '导入前的旧值', source: 'manual' },
    });

    const spy = installTransactionSpy();
    // 第 1 批正常提交（会真的写进去），第 2 批注入失败 —— 模拟 P2028 超时那一类故障
    const original = prisma.$transaction.bind(prisma) as unknown as TxFn;
    spy.mockImplementationOnce(original);
    spy.mockImplementationOnce(() => Promise.reject(new Error('注入：第 2 批事务失败')));

    const { status, body } = await importWeights({ rows });

    // 失败必须**如实上报**：不能返回「导入了一部分」的成功响应
    expect(status).toBe(500);
    const payload = body as { data: unknown; error: { code: string } };
    expect(payload.data).toBeNull();
    expect(payload.error.code).toBe('E_INTERNAL');

    // 全或无：第 1 批写的行被回滚掉，库里只剩那条**还原后**的旧记录
    expect(await weightCount()).toBe(1);
    expect(await weightAt(seedDate)).toEqual({ weightKg: 71.4, note: '导入前的旧值' });
  });
});
