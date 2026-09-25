/**
 * 四期全新项端到端测试（vitest + supertest，真实启动 Nest 应用 + 真实 SQLite）。
 *
 * 覆盖 R11.3 / R11.4 / R11.7 三项的后端契约：
 * - **R11.4** `POST /api/wins`：只记今天（body 里的 loggedDate 被剥离，QR-5 / K21）、
 *   空 400、超 60 字 400 **不截断不入库**（AC-11.4.2）、
 *   **★ 同一天两条 wins 能共存**（保护 `win_logs` 刻意不加的 (userId, loggedDate) 唯一约束）；
 *   `GET /api/wins`：**★ 210 条里只回最新 200 条且升序**（D-5：desc+take+reverse，
 *   写反成 ASC+take 会拿到最老的 200 条）、days 越界 400、跨用户隔离；
 *   `DELETE /api/wins/:id`：他人 → 404 `E_NOTFOUND_WIN`（K7）；
 * - **R11.3** `GET /api/report/period`：days 缺省 / 非 30|365 → 400（不允许隐式默认）、
 *   **响应键 == 白名单**（AC-11.3.2）、体重单条 → null / 两条 → 方向+差值（QR-4）、
 *   多源聚合（餐次 / 食物种类 / 运动 / wins / 有记录天数）；
 * - **R11.7** `GET /api/report/weekly` 向后兼容扩展：三字段齐全、同名合并、老字段不丢；
 * - **overview / export**：`wins` 行真实计数（Q-6 兑现）、导出 `meta.schemaVersion === 2`
 *   且 `wins` 为独立顶层键，v1 读法经 core `readExportWins` 返回 []。
 *
 * ⚠️ 与 `r11x.e2e.test.ts` 同机制：**加载 `dist/**` 编译产物**（esbuild 不生成 NestJS
 * 依赖注入所需的装饰器元数据）。
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

const { toLocalDateKey, readExportWins } = core;

const API = '/api';
const USER_A = 'e2e-r11n-a@qinglife.test';
const USER_B = 'e2e-r11n-b@qinglife.test';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;

let tokenA = '';
let tokenB = '';

/** 今天（服务端本地日粒度）。 */
const today = toLocalDateKey(new Date());

/** `YYYY-MM-DD` 加减天数（本地时区）。 */
function shiftDays(from: string, delta: number): string {
  const [year, month, day] = from.slice(0, 10).split('-').map((part) => Number(part));
  const date = new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() + delta);
  return toLocalDateKey(date);
}

/** 认证头。 */
function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** 登录（自用模式回显验证码，避免依赖日志抓取）。 */
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

/** 记一条自定义饮食（走 `POST /meals` 的 custom 分支）。 */
async function createMeal(
  token: string,
  input: { loggedDate: string; mealType: string; customName: string },
): Promise<void> {
  const res = await request(server as never)
    .post(`${API}/meals`)
    .set(auth(token))
    .send({
      loggedDate: input.loggedDate,
      mealType: input.mealType,
      customName: input.customName,
      customKcal: 100,
    })
    .expect(200);
  expect(res.body.error).toBeNull();
}

/** 记一条 win。 */
async function createWin(token: string, text: string): Promise<{ id: number; loggedDate: string; text: string }> {
  const res = await request(server as never)
    .post(`${API}/wins`)
    .set(auth(token))
    .send({ text })
    .expect(200);
  expect(res.body.error).toBeNull();
  return res.body.data as { id: number; loggedDate: string; text: string };
}

/** 取某用户的 id。 */
async function userIdOf(email: string): Promise<number> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user === null) {
    throw new Error(`用户 ${email} 不存在`);
  }
  return user.id;
}

beforeAll(async () => {
  // 自用模式：让 `/auth/send-code` 回显验证码（不依赖 .env，避免假阴性）
  process.env.AUTH_LOG_CODE = 'true';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  // 全局前缀在 `main.ts` 里设置，测试需自己补上（与 `r11x.e2e.test.ts` 一致）
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
  if (app !== undefined) {
    await app.close();
  }
});

describe('R11.4 · POST /api/wins', () => {
  it('只记今天：loggedDate 由服务端生成，body 里的 loggedDate 被剥离（QR-5 / K21）', async () => {
    const created = await createWin(tokenA, '今天爬楼没那么喘了');
    expect(created.loggedDate).toBe(today);
    expect(created.text).toBe('今天爬楼没那么喘了');

    // 客户端试图指定日期 → DTO 未声明该字段，被 whitelist 静默剥离，落库仍是今天
    const res = await request(server as never)
      .post(`${API}/wins`)
      .set(auth(tokenA))
      .send({ text: '补录是不允许的', loggedDate: '2020-01-01' })
      .expect(200);
    expect((res.body.data as { loggedDate: string }).loggedDate).toBe(today);
  });

  it('空文本 / 纯空白 → 400（想写点什么再记下来也行）', async () => {
    const res = await request(server as never)
      .post(`${API}/wins`)
      .set(auth(tokenA))
      .send({ text: '   ' })
      .expect(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
    expect(res.body.error.message).toContain('想写点什么');
  });

  it('★ 超 60 字 → 400 不截断不入库；正 60 字 → 200（AC-11.4.2）', async () => {
    const before = await prisma.winLog.count({ where: { userId: await userIdOf(USER_A) } });

    const tooLong = await request(server as never)
      .post(`${API}/wins`)
      .set(auth(tokenA))
      .send({ text: '啊'.repeat(61) })
      .expect(400);
    expect(tooLong.body.error.code).toBe('E_VALID_INPUT');
    expect(tooLong.body.error.message).toBe('最多能写 60 个字');
    expect(tooLong.body.error.fields?.text).toBeDefined();

    // 不截断不入库：数量没有变化，也没有存进 60 字的截断版本
    const after = await prisma.winLog.count({ where: { userId: await userIdOf(USER_A) } });
    expect(after).toBe(before);

    const exactly = await request(server as never)
      .post(`${API}/wins`)
      .set(auth(tokenA))
      .send({ text: '好'.repeat(60) })
      .expect(200);
    expect((exactly.body.data as { text: string }).text).toHaveLength(60);
  });

  it('★ 同一天两条 wins 能共存（保护 win_logs 刻意不加的唯一约束）', async () => {
    const uid = await userIdOf(USER_B);
    const before = await prisma.winLog.count({ where: { userId: uid, loggedDate: today } });

    // 同一用户、同一天连续记两条 —— 若未来有人"顺手"补上唯一约束，第二条会 500/409
    const first = await createWin(tokenB, 'R114-同日第一条');
    const second = await createWin(tokenB, 'R114-同日第二条');

    expect(first.id).not.toBe(second.id);
    const after = await prisma.winLog.count({ where: { userId: uid, loggedDate: today } });
    expect(after).toBe(before + 2);
  });

  it('无令牌 → 401', async () => {
    const res = await request(server as never).post(`${API}/wins`).send({ text: '匿名' }).expect(401);
    expect(res.body.error).not.toBeNull();
  });
});

describe('R11.4 · GET /api/wins', () => {
  it('days 越界 → 400（允许 1–365，AC-11.4.3）', async () => {
    const zero = await request(server as never)
      .get(`${API}/wins`)
      .query({ days: 0 })
      .set(auth(tokenA))
      .expect(400);
    expect(zero.body.error.code).toBe('E_VALID_INPUT');

    await request(server as never).get(`${API}/wins`).query({ days: 366 }).set(auth(tokenA)).expect(400);
  });

  it('★ 210 条里只回最新 200 条，且按写入时间升序（D-5：desc+take+reverse）', async () => {
    const uid = await userIdOf(USER_B);
    // 直接落库 210 条（同一 INSERT 批次 → createdAt 相同 → orderBy createdAt desc, id desc 稳定）
    await prisma.winLog.createMany({
      data: Array.from({ length: 210 }, (_, index) => ({
        userId: uid,
        loggedDate: today,
        text: `R114-批量-${String(index).padStart(3, '0')}`,
      })),
    });

    const res = await request(server as never).get(`${API}/wins`).query({ days: 365 }).set(auth(tokenB)).expect(200);
    const rows = res.body.data as Array<{ id: number; text: string }>;

    // 只回 200 条（不是 210、不是"最老的 200"）
    expect(rows).toHaveLength(200);

    // 升序呈现（时间线从早到晚）
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1]!.id).toBeLessThan(rows[i]!.id);
    }

    // 最新写入的在第 200 条位置；最老的 10 条被窗口丢弃
    const lastRow = rows[rows.length - 1]!;
    const newest = await prisma.winLog.findFirst({
      where: { userId: uid },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(lastRow.id).toBe(newest?.id);

    const oldest = await prisma.winLog.findFirst({
      where: { userId: uid },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(rows.find((row) => row.id === oldest?.id)).toBeUndefined();
  });

  it('跨用户隔离：A 看不到 B 的记录', async () => {
    const res = await request(server as never).get(`${API}/wins`).set(auth(tokenA)).expect(200);
    const rows = res.body.data as Array<{ text: string }>;
    expect(rows.find((row) => row.text.startsWith('R114-批量'))).toBeUndefined();
  });

  it('无令牌 → 401', async () => {
    const res = await request(server as never).get(`${API}/wins`).expect(401);
    expect(res.body.error).not.toBeNull();
  });
});

describe('R11.4 · DELETE /api/wins/:id', () => {
  it('他人的 win → 404 E_NOTFOUND_WIN（不泄露存在性，K7）', async () => {
    const uidB = await userIdOf(USER_B);
    const theirs = await prisma.winLog.findFirst({ where: { userId: uidB }, orderBy: { id: 'desc' } });
    expect(theirs).not.toBeNull();

    const res = await request(server as never)
      .delete(`${API}/wins/${theirs?.id}`)
      .set(auth(tokenA))
      .expect(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_WIN');
    expect(res.body.error.message).toBe('没有找到这一条');
  });

  it('本人的 win → 200 { deleted: true }，行被删除', async () => {
    const created = await createWin(tokenA, 'R114-待删');

    const res = await request(server as never)
      .delete(`${API}/wins/${created.id}`)
      .set(auth(tokenA))
      .expect(200);
    expect(res.body.data).toEqual({ deleted: true });

    const gone = await prisma.winLog.findUnique({ where: { id: created.id } });
    expect(gone).toBeNull();
  });
});

describe('R11.3 · GET /api/report/period', () => {
  /** `PeriodReport` 白名单全键（6 类指标 + from/to/days/hasAnyData 骨架）。 */
  const PERIOD_KEYS = [
    'days',
    'distinctFoodCount',
    'exercise',
    'from',
    'hasAnyData',
    'loggedDays',
    'mealEntryCount',
    'topHabits',
    'to',
    'weight',
    'winCount',
  ].sort();

  it('days 缺省 / 非 30|365 → 400（不允许隐式默认，QR-3）', async () => {
    const missing = await request(server as never).get(`${API}/report/period`).set(auth(tokenB)).expect(400);
    expect(missing.body.error.code).toBe('E_VALID_INPUT');

    for (const days of [90, 7, 0, -30]) {
      await request(server as never)
        .get(`${API}/report/period`)
        .query({ days })
        .set(auth(tokenB))
        .expect(400);
    }
  });

  it('days=30 与 days=365 → 200', async () => {
    await request(server as never).get(`${API}/report/period`).query({ days: 30 }).set(auth(tokenB)).expect(200);
    await request(server as never).get(`${API}/report/period`).query({ days: 365 }).set(auth(tokenB)).expect(200);
  });

  it('★ 响应键 == 白名单（AC-11.3.2）：多一个键都算破白名单', async () => {
    const res = await request(server as never)
      .get(`${API}/report/period`)
      .query({ days: 30 })
      .set(auth(tokenB))
      .expect(200);
    const data = res.body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(PERIOD_KEYS);
  });

  it('多源聚合：餐次 / 食物种类（同名合并）/ 运动 / wins / 有记录天数', async () => {
    // 种数据：3 笔饮食（2 种）、1 次运动、B 名下已有大量 wins（前一组用例写入）
    await createMeal(tokenB, { loggedDate: shiftDays(today, -5), mealType: 'lunch', customName: 'R113-米饭' });
    await createMeal(tokenB, { loggedDate: shiftDays(today, -3), mealType: 'dinner', customName: 'R113-米饭' });
    await createMeal(tokenB, { loggedDate: shiftDays(today, -1), mealType: 'lunch', customName: 'R113-面条' });

    const activity = await prisma.metActivity.findFirst();
    expect(activity).not.toBeNull();
    await prisma.exerciseLog.create({
      data: {
        userId: await userIdOf(USER_B),
        loggedDate: shiftDays(today, -4),
        activityCode: activity!.code,
        activityName: activity!.name,
        met: 3,
        minutes: 40,
        weightKgAtLog: 70,
        kcalBurned: 120,
      },
    });

    const res = await request(server as never)
      .get(`${API}/report/period`)
      .query({ days: 30 })
      .set(auth(tokenB))
      .expect(200);
    const data = res.body.data as {
      from: string;
      to: string;
      days: number;
      hasAnyData: boolean;
      loggedDays: number;
      distinctFoodCount: number;
      mealEntryCount: number;
      topHabits: unknown[];
      exercise: { sessions: number; totalMinutes: number };
      winCount: number;
    };

    expect(data.days).toBe(30);
    expect(data.from).toBe(shiftDays(today, -29));
    expect(data.to).toBe(today);
    expect(data.hasAnyData).toBe(true);
    expect(data.mealEntryCount).toBe(3);
    // 库内米饭 + 快加米饭同 display 名 → 同一种（K16，与 core distinctFoodKeys 同源）
    expect(data.distinctFoodCount).toBe(2);
    expect(data.exercise).toEqual({ sessions: 1, totalMinutes: 40 });

    // winCount 与库内真实条数一致（唯一计数出口，AC-11.4.6）
    const expectedWins = await prisma.winLog.count({
      where: { userId: await userIdOf(USER_B), loggedDate: { gte: shiftDays(today, -29), lte: today } },
    });
    expect(expectedWins).toBeGreaterThan(0);
    expect(data.winCount).toBe(expectedWins);

    // 有记录的天数：餐次 {-5,-3,-1} ∪ 运动 {-4} ∪ wins/体重等当日记录 → 至少 5 天
    expect(data.loggedDays).toBeGreaterThanOrEqual(5);
    // 无习惯打卡 → 空数组（不是 null / 缺字段）
    expect(data.topHabits).toEqual([]);
  });

  it('体重：无记录 → null；单条 → null；两条 → 方向 + 差值，无任何评价字段（QR-4）', async () => {
    const uid = await userIdOf(USER_B);

    // 无记录 → null
    const empty = await request(server as never)
      .get(`${API}/report/period`)
      .query({ days: 30 })
      .set(auth(tokenB))
      .expect(200);
    expect((empty.body.data as { weight: unknown }).weight).toBeNull();

    // 单条 → 仍是 null（首末是同一条记录）
    await prisma.weightLog.create({
      data: { userId: uid, loggedAt: shiftDays(today, -2), weightKg: 70 },
    });
    const single = await request(server as never)
      .get(`${API}/report/period`)
      .query({ days: 30 })
      .set(auth(tokenB))
      .expect(200);
    expect((single.body.data as { weight: unknown }).weight).toBeNull();

    // 两条 → { startKg, endKg, deltaKg }，只有三个数字键
    await prisma.weightLog.create({
      data: { userId: uid, loggedAt: today, weightKg: 67.8 },
    });
    const both = await request(server as never)
      .get(`${API}/report/period`)
      .query({ days: 30 })
      .set(auth(tokenB))
      .expect(200);
    const weight = (both.body.data as { weight: { startKg: number; endKg: number; deltaKg: number } }).weight;
    expect(weight).toEqual({ startKg: 70, endKg: 67.8, deltaKg: -2.2 });
  });

  it('★ endDate=2026-02-31 → 400（不存在的日期不得被静默进位到 3 月）', async () => {
    const res = await request(server as never)
      .get(`${API}/report/period`)
      .query({ days: 30, endDate: '2026-02-31' })
      .set(auth(tokenB))
      .expect(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
    expect(res.body.error.fields.endDate).toBeDefined();
  });

  it('endDate 合法 → 200', async () => {
    await request(server as never)
      .get(`${API}/report/period`)
      .query({ days: 30, endDate: '2026-02-28' })
      .set(auth(tokenB))
      .expect(200);
  });

  it('无令牌 → 401', async () => {
    const res = await request(server as never).get(`${API}/report/period`).query({ days: 30 }).expect(401);
    expect(res.body.error).not.toBeNull();
  });
});

describe('R11.7 · GET /api/report/weekly 向后兼容扩展', () => {
  it('新增三字段齐全：同名跨天合并计数；老字段不丢（AC-11.7.6）', async () => {
    // 3 笔饮食、2 种（「R117-米饭」跨 2 天只算 1 种 —— 与 core distinctFoodKeys 同口径）
    await createMeal(tokenA, { loggedDate: today, mealType: 'lunch', customName: 'R117-米饭' });
    await createMeal(tokenA, { loggedDate: shiftDays(today, -1), mealType: 'dinner', customName: 'R117-米饭' });
    await createMeal(tokenA, { loggedDate: today, mealType: 'breakfast', customName: 'R117-面条' });

    const res = await request(server as never)
      .get(`${API}/report/weekly`)
      .set(auth(tokenA))
      .expect(200);
    const data = res.body.data as {
      from: string;
      to: string;
      days: unknown[];
      avgIntakeKcal: number;
      micronutrients: unknown[];
      distinctFoodCount: number;
      distinctFoods: string[];
      distinctFoodsTruncated: boolean;
    };

    // 新字段
    expect(data.distinctFoodCount).toBe(2);
    expect(data.distinctFoods).toContain('R117-米饭');
    expect(data.distinctFoods).toContain('R117-面条');
    expect(data.distinctFoodsTruncated).toBe(false);

    // 老字段一个不丢
    expect(data.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.days).toHaveLength(7);
    expect(typeof data.avgIntakeKcal).toBe('number');
    expect(Array.isArray(data.micronutrients)).toBe(true);
  });

  it('★ endDate=2026-02-31 → 400（此前 weekly 的 endDate 是裸参数，完全未校验）', async () => {
    const res = await request(server as never)
      .get(`${API}/report/weekly`)
      .query({ endDate: '2026-02-31' })
      .set(auth(tokenA))
      .expect(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
    expect(res.body.error.fields.endDate).toBeDefined();
  });

  it('endDate 合法 → 200（口径与 /report/period 一致）', async () => {
    await request(server as never)
      .get(`${API}/report/weekly`)
      .query({ endDate: '2026-02-28' })
      .set(auth(tokenA))
      .expect(200);
  });
});

describe('R11.4 ↔ R11.6 · overview 真实计数 与 导出 v2', () => {
  it('GET /data/overview 的 wins 行 = 真实计数（Q-6 预留位兑现）', async () => {
    const uid = await userIdOf(USER_A);
    const expected = await prisma.winLog.count({ where: { userId: uid } });
    expect(expected).toBeGreaterThan(0); // 前面用例已给 A 记过 wins

    const res = await request(server as never).get(`${API}/data/overview`).set(auth(tokenA)).expect(200);
    const rows = (res.body.data as { rows: Array<{ key: string; count: number; firstDate: string | null; lastDate: string | null }> }).rows;
    const wins = rows.find((row) => row.key === 'wins');
    expect(wins?.count).toBe(expected);
    expect(wins?.lastDate).toBe(today);
  });

  it('GET /data/export → schemaVersion 2 + wins 独立顶层键；v1 读法返回 []（QR-6）', async () => {
    const res = await request(server as never).get(`${API}/data/export`).set(auth(tokenA)).expect(200);
    const payload = res.body.data as {
      meta: { app: string; schemaVersion: number; exportedAt: string };
      wins: Array<{ date: string; text: string }>;
    };

    expect(payload.meta.schemaVersion).toBe(2);
    expect(Array.isArray(payload.wins)).toBe(true);
    expect(payload.wins.length).toBeGreaterThan(0);
    for (const row of payload.wins) {
      expect(typeof row.date).toBe('string');
      expect(typeof row.text).toBe('string');
    }

    // 服务端导出的 v2 wins 可被 core 的兼容读法原样读回
    const readBack = readExportWins(payload) as Array<{ date: string; text: string }>;
    expect(readBack).toHaveLength(payload.wins.length);

    // v1（去掉 wins 键）→ []，绝不抛错
    const v1 = payload as Record<string, unknown>;
    delete v1.wins;
    expect(readExportWins(v1)).toEqual([]);
  });
});
