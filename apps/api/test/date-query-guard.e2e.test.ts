/**
 * 读取侧日期键防御（缺陷注入反验）：`GET /exercises`、`GET /water`、`DELETE /water/last`。
 *
 * **缺陷**：三处 `@Query('date') date?: string` 是裸参数、无管道 —— 写入侧
 * （`@IsLocalDateKey()`，形状 + **日历真实性**）早已拦住的 `2026-02-31`，
 * 在读取侧直接进 service 查库 → 200 + 空列表 / 404「没有可撤销的记录」。
 * 用户看到的是「数据没了」，真实原因是「日期不存在」。两侧口径不一致。
 *
 * **修法**：`LocalDateKeyQueryPipe` 复用 `isValidLocalDateKey`，与写入侧同一真源。
 *
 * ⚠️ **为什么每条非法值都必须配一条合法值**：只钉「`2026-02-31` → 400」是不够的 ——
 * 把判据写成「拒绝所有 2 月末」「拒绝所有非今天」同样能变绿。所以每个非法值都配
 * **邻近的合法值**（闰年 `2024-02-29`、`2026-12-31`、`2026-02-28`、`2026-03-01`）
 * 护住：它们必须 200，且能真的查到当天记录。
 *
 * **缺陷注入反验**（改管道为裸正则 `^\d{4}-\d{2}-\d{2}$` 后必须红）：
 * 见文件末尾 `describe('🔴 注入探针')`。
 *
 * ⚠️ 与 `datekey-guard.e2e.test.ts` 同机制：**加载 `dist/**` 编译产物**
 * （esbuild 不生成 NestJS DI 所需的装饰器元数据）。跑前需 `tsc -p tsconfig.build.json`
 * **并** `node scripts/rewrite-aliases.cjs`（少了第二步 `dist` 会残留 `require("@qsh/core")`）。
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
const USER = 'e2e-date-query-guard@qinglife.test';

/** 形状合法（`^\d{4}-\d{2}-\d{2}$`）但日历上不存在的日期 —— 裸正则的漏网之鱼。 */
const IMPOSSIBLE_DATES = [
  '2026-02-31', // 2 月没有 31 日（本轮的核心缺陷）
  '2026-02-29', // 2026 不是闰年
  '2025-02-29', // 2025 不是闰年
  '2026-04-31', // 4 月只有 30 天
  '2026-13-01', // 13 月
  '2026-00-10', // 0 月
  '2026-00-00', // 0 月 0 日
];

/** 邻近的合法日期 —— 用来证明「不是把 2 月末/年末一律拒掉」。 */
const POSSIBLE_DATES = [
  '2024-02-29', // 真闰年（与 2026-02-29 唯一差别是年份，必须放行）
  '2026-02-28', // 2026-02-31 的前一天
  '2026-03-01', // 2026-02-31 的后一天
  '2026-12-31', // 年末
  '2026-01-01', // 年初
];

/** 连形状都不对的值。 */
const MALFORMED_DATES = ['abc', '2026-2-3', '2026/02/28', '20260228', '2026-02-31T00:00:00Z'];

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let token = '';
let userId = 0;

/** 认证头。 */
function auth(value: string): { Authorization: string } {
  return { Authorization: `Bearer ${value}` };
}

/** 登录（自用模式回显验证码）。 */
async function login(email: string): Promise<string> {
  const sent = await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  const code = (sent.body.data as { code?: string }).code;
  if (typeof code !== 'string') {
    throw new Error(`未取到 ${email} 的验证码回显（请确认 AUTH_LOG_CODE=true）`);
  }
  const verified = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email, code })
    .expect(200);
  return (verified.body.data as { accessToken: string }).accessToken;
}

/** 本地今天（避免 UTC 日错位，与被测 service 同口径）。 */
function todayKey(): string {
  const now = new Date();
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 发一个真实 HTTP 请求，返回状态码与响应体。 */
async function call(
  method: 'get' | 'delete',
  path: string,
  date?: string,
): Promise<{ status: number; body: { data: unknown; error: { code: string; fields?: Record<string, string> } | null } }> {
  let req = request(server as never)[method](`${API}${path}`).set(auth(token));
  // `.query()` 对空串会编码成 `date=`（正是本轮要钉的边界），故手写查询串
  if (date !== undefined) {
    req = req.query(`date=${encodeURIComponent(date)}`);
  }
  const res = await req;
  return {
    status: res.status as number,
    body: res.body as { data: unknown; error: { code: string; fields?: Record<string, string> } | null },
  };
}

/** 记一条运动（指定日期）。 */
async function createExercise(date: string, activityCode = 'walking_brisk'): Promise<number> {
  const res = await request(server as never)
    .post(`${API}/exercises`)
    .set(auth(token))
    .send({ activityCode, minutes: 30, loggedDate: date })
    .expect(200);
  return (res.body.data as { id: number }).id;
}

/** 记一笔饮水（指定日期）。 */
async function createWater(date: string, amountMl = 250): Promise<number> {
  const res = await request(server as never)
    .post(`${API}/water`)
    .set(auth(token))
    .send({ amountMl, loggedDate: date })
    .expect(200);
  const logs = (res.body.data as { logs: Array<{ id: number }> }).logs;
  return logs[logs.length - 1]!.id;
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
  await prisma.exerciseLog.deleteMany({ where: { userId } });
  await prisma.waterLog.deleteMany({ where: { userId } });
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.exerciseLog.deleteMany({ where: { userId } });
    await prisma.waterLog.deleteMany({ where: { userId } });
    await prisma.authVerificationCode.deleteMany({ where: { email: USER } });
    await prisma.user.deleteMany({ where: { email: USER } });
  }
  if (app !== undefined) {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 🔴 缺陷 1：`GET /api/exercises?date=`
// ---------------------------------------------------------------------------

describe('🔴 缺陷 1 · GET /api/exercises 的 date 必须与写入侧同口径', () => {
  it('★ ?date=2026-02-31 → 400 E_VALID_INPUT（修复前 200 + 空列表）', async () => {
    const res = await call('get', '/exercises', '2026-02-31');
    expect(res.status, '2026-02-31 不是真实日期，必须 400').toBe(400);
    expect(res.body.error).not.toBeNull();
    expect(res.body.error!.code).toBe('E_VALID_INPUT');
    // 错误明细挂在 `date` 字段上（与全局校验管道的 fields 结构一致）
    expect(res.body.error!.fields?.date).toBeTruthy();
  });

  it('★ 全部「形状合法但不存在」的日期 → 400（13 月 / 0 月 / 平年 2-29 一并钉住）', async () => {
    for (const bad of IMPOSSIBLE_DATES) {
      const res = await call('get', '/exercises', bad);
      expect(res.status, `${bad} 应被拒`).toBe(400);
    }
  });

  it('★ 2024-02-29（真闰年）→ 200，且与 2026-02-29 → 400 结论相反（成对钉）', async () => {
    const leap = await call('get', '/exercises', '2024-02-29');
    expect(leap.status, '2024-02-29 是真实日期，必须放行').toBe(200);
    expect((leap.body.data as { date: string }).date).toBe('2024-02-29');

    const nonLeap = await call('get', '/exercises', '2026-02-29');
    expect(nonLeap.status, '2026 不是闰年，2026-02-29 必须被拒').toBe(400);

    // 两条结论必须相反 —— 只钉其中一条的实现（如「拒绝所有 2 月末」）会被这条抓住
    expect(leap.status).not.toBe(nonLeap.status);
  });

  it('★ 2026-12-31 → 200（护住年末，防「拒绝 31 日」型实现蒙对）', async () => {
    const res = await call('get', '/exercises', '2026-12-31');
    expect(res.status).toBe(200);
    expect((res.body.data as { date: string }).date).toBe('2026-12-31');
  });

  it('2026-02-31 的邻近合法日期 2026-02-28 / 2026-03-01 都放行', async () => {
    for (const good of ['2026-02-28', '2026-03-01', '2026-01-01']) {
      const res = await call('get', '/exercises', good);
      expect(res.status, `${good} 应放行`).toBe(200);
      expect((res.body.data as { date: string }).date).toBe(good);
    }
  });

  it('★ 合法日期能真的查到当天记录（防「合法值一律返回空」型实现）', async () => {
    const id = await createExercise('2024-02-29');
    const res = await call('get', '/exercises', '2024-02-29');
    expect(res.status).toBe(200);
    const data = res.body.data as { date: string; logs: Array<{ id: number }>; totalKcal: number };
    expect(data.date).toBe('2024-02-29');
    expect(data.logs.map((log) => log.id)).toContain(id);
    expect(data.totalKcal).toBeGreaterThan(0);
  });

  it('连形状都不对的值 → 400（abc / 2026-2-3 / 2026/02/28 / ISO 串）', async () => {
    for (const bad of MALFORMED_DATES) {
      const res = await call('get', '/exercises', bad);
      expect(res.status, `${bad} 应被拒`).toBe(400);
    }
  });

  it('不传 date → 200 且 date 为今天（缺省语义不变，管道不得替 service 选今天）', async () => {
    const res = await call('get', '/exercises');
    expect(res.status).toBe(200);
    expect((res.body.data as { date: string }).date).toBe(todayKey());
  });

  it('★ ?date=（空串）视同未传 → 200 且按今天处理（不是 400，也不是空结果）', async () => {
    const id = await createExercise(todayKey());
    const res = await call('get', '/exercises', '');
    expect(res.status, '空 query 是无心行为，不该报错').toBe(200);
    const data = res.body.data as { date: string; logs: Array<{ id: number }> };
    expect(data.date).toBe(todayKey());
    expect(data.logs.map((log) => log.id)).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// 🔴 缺陷 2：`GET /api/water?date=`
// ---------------------------------------------------------------------------

describe('🔴 缺陷 2 · GET /api/water 的 date 必须与写入侧同口径', () => {
  it('★ ?date=2026-02-31 → 400 E_VALID_INPUT', async () => {
    const res = await call('get', '/water', '2026-02-31');
    expect(res.status).toBe(400);
    expect(res.body.error!.code).toBe('E_VALID_INPUT');
    expect(res.body.error!.fields?.date).toBeTruthy();
  });

  it('★ 全部「形状合法但不存在」的日期 → 400', async () => {
    for (const bad of IMPOSSIBLE_DATES) {
      const res = await call('get', '/water', bad);
      expect(res.status, `${bad} 应被拒`).toBe(400);
    }
  });

  it('★ 闰年 2024-02-29 → 200 / 平年 2026-02-29 → 400（成对钉）', async () => {
    const leap = await call('get', '/water', '2024-02-29');
    expect(leap.status).toBe(200);
    expect((leap.body.data as { date: string }).date).toBe('2024-02-29');

    const nonLeap = await call('get', '/water', '2026-02-29');
    expect(nonLeap.status).toBe(400);
    expect(leap.status).not.toBe(nonLeap.status);
  });

  it('★ 2026-12-31 → 200，且能查到当天记的水量', async () => {
    const id = await createWater('2026-12-31', 300);
    const res = await call('get', '/water', '2026-12-31');
    expect(res.status).toBe(200);
    const data = res.body.data as { date: string; totalMl: number; logs: Array<{ id: number }> };
    expect(data.date).toBe('2026-12-31');
    expect(data.logs.map((log) => log.id)).toContain(id);
    expect(data.totalMl).toBe(300);
  });

  it('不传 date → 200 且为今天；?date=（空串）同样按今天处理', async () => {
    const noParam = await call('get', '/water');
    expect(noParam.status).toBe(200);
    expect((noParam.body.data as { date: string }).date).toBe(todayKey());

    const id = await createWater(todayKey(), 250);
    const empty = await call('get', '/water', '');
    expect(empty.status).toBe(200);
    const data = empty.body.data as { date: string; logs: Array<{ id: number }> };
    expect(data.date).toBe(todayKey());
    expect(data.logs.map((log) => log.id)).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// 🔴 缺陷 3：`DELETE /api/water/last?date=`（写操作，掩码风险最高）
// ---------------------------------------------------------------------------

describe('🔴 缺陷 3 · DELETE /api/water/last 的 date 必须与写入侧同口径', () => {
  it('★ ?date=2026-02-31 → 400（修复前是 404「今天还没有可撤销的记录」）', async () => {
    const res = await call('delete', '/water/last', '2026-02-31');
    expect(res.status, '日期不存在应报错，而不是伪装成「没记录」').toBe(400);
    expect(res.body.error!.code).toBe('E_VALID_INPUT');
  });

  it('★ 全部「形状合法但不存在」的日期 → 400', async () => {
    for (const bad of IMPOSSIBLE_DATES) {
      const res = await call('delete', '/water/last', bad);
      expect(res.status, `${bad} 应被拒`).toBe(400);
    }
  });

  it('★ 合法日期被放行：2024-02-29 无记录 → 404（不是 400，证明键本身通过）', async () => {
    const res = await call('delete', '/water/last', '2024-02-29');
    expect(res.status).toBe(404);
    expect(res.body.error!.code).toBe('E_NOTFOUND_WATER');
  });

  it('★ 合法日期真的能撤销：2024-02-29 记一笔再撤销 → 200 undone', async () => {
    await createWater('2024-02-29', 250);
    const res = await call('delete', '/water/last', '2024-02-29');
    expect(res.status).toBe(200);
    expect((res.body.data as { undone: boolean }).undone).toBe(true);
    expect(await prisma.waterLog.count({ where: { userId, loggedDate: '2024-02-29' } })).toBe(0);
  });

  it('★ 2026-12-31 也能撤销（护住年末，防「拒绝 31 日」型实现）', async () => {
    await createWater('2026-12-31', 250);
    const res = await call('delete', '/water/last', '2026-12-31');
    expect(res.status).toBe(200);
    expect(await prisma.waterLog.count({ where: { userId, loggedDate: '2026-12-31' } })).toBe(0);
  });

  it('?date=（空串）视同未传 → 撤销今天的那一条', async () => {
    await createWater(todayKey(), 250);
    const res = await call('delete', '/water/last', '');
    expect(res.status).toBe(200);
    expect((res.body.data as { undone: boolean }).undone).toBe(true);
    expect(await prisma.waterLog.count({ where: { userId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 注入探针：把管道退化成「只验形状」后，下面这条必须红
// ---------------------------------------------------------------------------

describe('🔴 注入探针 · 与裸正则实现的可分辨性', () => {
  it('同一批日期在「非法 / 合法」上给出不同结论（裸正则实现会让两者都是 200）', async () => {
    const bad = await call('get', '/exercises', '2026-02-31');
    const good = await call('get', '/exercises', '2026-02-28');
    expect(bad.status).toBe(400);
    expect(good.status).toBe(200);
    // 若实现退化成裸 `^\d{4}-\d{2}-\d{2}$`，两条都是 200 → 本条必红
    expect(bad.status).not.toBe(good.status);
  });

  it('写入侧与读取侧对同一个坏日期结论一致（口径统一的核心证据）', async () => {
    const write = await request(server as never)
      .post(`${API}/exercises`)
      .set(auth(token))
      .send({ activityCode: 'walking_brisk', minutes: 30, loggedDate: '2026-02-31' })
      .then((r: { status: number }) => r.status);
    const read = await call('get', '/exercises', '2026-02-31');
    expect(write).toBe(400);
    expect(read.status).toBe(400);
    expect(await prisma.exerciseLog.count({ where: { userId, loggedDate: '2026-02-31' } })).toBe(0);
  });
});
