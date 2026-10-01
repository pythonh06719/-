/**
 * 记录足迹日历端到端测试（C-1，`GET /api/report/calendar`）。
 *
 * ## 钉死的口径
 * - 返回某月**有记录的日子 + 当天记了哪几类**（`kinds`，按固定顺序去重），**只有分子没有分母**；
 * - **跨用户隔离**：他人记录绝不进入本人的足迹（含「同一天、他人记了别的类」这条最易漏的路径）；
 * - **空月份** → `days: []`（不是报错、不是 404）；
 * - 月份参数非法（`2026-13` / `2026-3` / 非数字）→ 400；无 token → 401。
 *
 * ⚠️ 与 `r11-new.e2e.test.ts` / `report-daily-avg-denominator.e2e.test.ts` 同机制：
 * **加载 `dist/**` 编译产物**（esbuild 不生成 NestJS 依赖注入所需的装饰器元数据），
 * 改 `report.service.ts` / `report.controller.ts` 后须先 `nest build`。
 *
 * ⚠️ 固定用 **2026-03**（过去月份），与「今天」无关（本接口不做「裁剪到今天」）。
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
const { AppModule } = require('../dist/apps/api/src/app.module.js') as {
  AppModule: typeof AppModuleClass;
};
const { PrismaService } = require('../dist/apps/api/src/prisma/prisma.service.js') as {
  PrismaService: typeof PrismaServiceClass;
};

const API = '/api';
/** 被测月份（固定，过去月份）。 */
const MONTH = '2026-03';
const USER = 'e2e-calendar@qinglife.test';
const OTHER = 'e2e-calendar-other@qinglife.test';
/** 自建习惯 code（带唯一前缀，清理只按此前缀删）。 */
const HABIT_CODE = 'e2e_cal_habit';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let token = '';
let otherToken = '';

function auth(value: string): { Authorization: string } {
  return { Authorization: `Bearer ${value}` };
}

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

async function userIdOf(email: string): Promise<number> {
  const user = await prisma.user.findFirst({ where: { email }, select: { id: true } });
  if (user === null) {
    throw new Error(`未找到用户 ${email}`);
  }
  return user.id;
}

/** 查询某月足迹（返回响应体 `data`）。 */
async function fetchCalendar(value: string, month: string): Promise<{ month: string; from: string; to: string; days: Array<{ date: string; kinds: string[] }> }> {
  const res = await request(server as never).get(`${API}/report/calendar`).query({ month }).set(auth(value)).expect(200);
  return res.body.data as { month: string; from: string; to: string; days: Array<{ date: string; kinds: string[] }> };
}

beforeAll(async () => {
  process.env.AUTH_LOG_CODE = 'true';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  server = app.getHttpServer();
  prisma = moduleRef.get<PrismaServiceClass>(PrismaService);

  await prisma.authVerificationCode.deleteMany({ where: { email: { in: [USER, OTHER] } } });
  await prisma.user.deleteMany({ where: { email: { in: [USER, OTHER] } } });

  token = await login(USER);
  otherToken = await login(OTHER);
  const me = await userIdOf(USER);
  const them = await userIdOf(OTHER);

  // 运动外键依赖 MET 表：确保内置「快走」存在（幂等）
  await prisma.metActivity.upsert({
    where: { code: 'walking_brisk' },
    update: {},
    create: { code: 'walking_brisk', name: '快走', category: '步行', met: 5, isBuiltin: true, source: 'e2e' },
  });

  // ---- 本人（USER）：5 天有记录，覆盖 5 类模块 ----
  // 03-03：只有饮食
  await prisma.mealLog.create({
    data: { userId: me, loggedDate: '2026-03-03', mealType: 'lunch', kcal: 100, source: 'search' },
  });
  // 03-10：饮食 + 体重 + 饮水（3 类 → 最深档）
  await prisma.mealLog.create({
    data: { userId: me, loggedDate: '2026-03-10', mealType: 'lunch', kcal: 200, source: 'search' },
  });
  await prisma.weightLog.create({ data: { userId: me, loggedAt: '2026-03-10', weightKg: 60 } });
  await prisma.waterLog.create({ data: { userId: me, loggedDate: '2026-03-10', amountMl: 250 } });
  // 03-18：运动
  await prisma.exerciseLog.create({
    data: {
      userId: me,
      loggedDate: '2026-03-18',
      activityCode: 'walking_brisk',
      activityName: '快走',
      met: 5,
      minutes: 30,
      weightKgAtLog: 60,
      kcalBurned: 150,
    },
  });
  // 03-20：习惯打卡
  const habit = await prisma.habitDefinition.create({
    data: { userId: me, code: HABIT_CODE, name: 'E2E-CAL 习惯', targetPerDay: 1 },
    select: { id: true },
  });
  await prisma.habitCheckin.create({ data: { userId: me, habitId: habit.id, loggedDate: '2026-03-20', done: true } });
  // 03-22：体重之外的变化（服务端只允许记今天，故直接落库以定位到固定月）
  await prisma.winLog.create({ data: { userId: me, loggedDate: '2026-03-22', text: 'E2E-CAL 走楼梯不喘了' } });

  // ---- 他人（OTHER）：03-03 记「体重」、03-04 记「饮食」—— 都不得进入本人足迹 ----
  await prisma.weightLog.create({ data: { userId: them, loggedAt: '2026-03-03', weightKg: 70 } });
  await prisma.mealLog.create({
    data: { userId: them, loggedDate: '2026-03-04', mealType: 'dinner', kcal: 300, source: 'search' },
  });
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.authVerificationCode.deleteMany({ where: { email: { in: [USER, OTHER] } } });
    // 级联删除本人 / 他人的全部记录（含自建习惯与打卡）
    await prisma.user.deleteMany({ where: { email: { in: [USER, OTHER] } } });
  }
  if (app !== undefined) {
    await app.close();
  }
});

describe('GET /api/report/calendar（C-1 记录足迹日历）', () => {
  it('★ 返回该月「有记录的日子 + 记了哪几类」——日期集合与 kinds 精确正确', async () => {
    const data = await fetchCalendar(token, MONTH);

    expect(data.month).toBe(MONTH);
    expect(data.from).toBe('2026-03-01');
    expect(data.to).toBe('2026-03-31');

    // 只有 5 天有记录，且按日期升序
    expect(data.days.map((day) => day.date)).toEqual([
      '2026-03-03',
      '2026-03-10',
      '2026-03-18',
      '2026-03-20',
      '2026-03-22',
    ]);

    const byDate = new Map(data.days.map((day) => [day.date, day.kinds]));
    // kinds 按固定顺序（weight → meal → exercise → habit → water → win）
    expect(byDate.get('2026-03-03')).toEqual(['meal']);
    expect(byDate.get('2026-03-10')).toEqual(['weight', 'meal', 'water']);
    expect(byDate.get('2026-03-18')).toEqual(['exercise']);
    expect(byDate.get('2026-03-20')).toEqual(['habit']);
    expect(byDate.get('2026-03-22')).toEqual(['win']);
  });

  it('★ 跨用户隔离：他人记录不影响本人结果（含「同一天他人记了别的类」）', async () => {
    const mine = await fetchCalendar(token, MONTH);

    // 03-03 本人只记了饮食：不得因为「他人当天记了体重」而多出 weight
    const march3 = mine.days.find((day) => day.date === '2026-03-03');
    expect(march3?.kinds).toEqual(['meal']);

    // 他人 03-04 的饮食不得出现在本人足迹里
    expect(mine.days.some((day) => day.date === '2026-03-04')).toBe(false);

    // 交叉验证：他人自己的足迹里 03-04 存在、03-03 只有体重
    const theirs = await fetchCalendar(otherToken, MONTH);
    expect(theirs.days.map((day) => day.date)).toEqual(['2026-03-03', '2026-03-04']);
    expect(theirs.days.find((day) => day.date === '2026-03-03')?.kinds).toEqual(['weight']);
    expect(theirs.days.find((day) => day.date === '2026-03-04')?.kinds).toEqual(['meal']);
  });

  it('★ 空月份（一天没记）→ days 为空数组，而不是报错', async () => {
    const data = await fetchCalendar(token, '2026-04');
    expect(data.month).toBe('2026-04');
    expect(data.from).toBe('2026-04-01');
    expect(data.to).toBe('2026-04-30');
    expect(data.days).toEqual([]);
  });

  it('月份参数缺失 / 非法 → 400（不允许隐式默认）', async () => {
    await request(server as never).get(`${API}/report/calendar`).set(auth(token)).expect(400);
    await request(server as never).get(`${API}/report/calendar`).query({ month: '2026-13' }).set(auth(token)).expect(400);
    await request(server as never).get(`${API}/report/calendar`).query({ month: '2026-3' }).set(auth(token)).expect(400);
    await request(server as never).get(`${API}/report/calendar`).query({ month: 'abc' }).set(auth(token)).expect(400);
  });

  it('无 token → 401', async () => {
    await request(server as never).get(`${API}/report/calendar`).query({ month: MONTH }).expect(401);
  });

  it('非法月份 2026-13 的响应带字段级说明（E_VALID_INPUT）', async () => {
    const res = await request(server as never)
      .get(`${API}/report/calendar`)
      .query({ month: '2026-13' })
      .set(auth(token))
      .expect(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
  });
});
