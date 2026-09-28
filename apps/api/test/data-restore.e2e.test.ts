/**
 * JSON 备份恢复端到端测试：真实 Nest 应用 + SQLite，覆盖两段式确认、合并、隔离与事务回滚。
 */
import 'reflect-metadata';

import { createRequire } from 'node:module';

import type { INestApplication } from '@nestjs/common';
import type { ExportJsonPayload, RestorePreviewResponse } from '@qsh/shared-types';
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
const USER_A = 'e2e-restore-a@qinglife.test';
const USER_B = 'e2e-restore-b@qinglife.test';
const UNTOUCHED_DATE = '2026-08-01';
const SAME_DATE = '2026-08-02';
const NEW_DATE = '2026-08-03';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let tokenA = '';
let tokenB = '';
let userAId = 0;
let userBId = 0;

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
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

function validPayload(overrides: Partial<ExportJsonPayload> = {}): ExportJsonPayload {
  return {
    meta: { app: 'qingshenghuo', schemaVersion: 2, exportedAt: '2026-09-12T00:00:00.000Z' },
    profile: {
      gender: 'female',
      birthDate: '1992-04-03',
      heightCm: 165,
      activityLevel: 'light',
      dietaryPreference: ['清淡'],
      conditions: [],
    },
    goals: {
      targetWeightKg: 58,
      targetWeeks: 12,
      macroRatio: { protein: 25, fat: 25, carb: 50 },
    },
    weights: [],
    meals: [],
    exercises: [],
    habits: [],
    water: [],
    wins: [],
    settings: { unit: 'kcal', darkMode: false, fastingEnabled: false },
    ...overrides,
  };
}

async function preview(token: string, payload: ExportJsonPayload): Promise<RestorePreviewResponse> {
  const response = await request(server as never)
    .post(`${API}/data/restore/preview`)
    .set(auth(token))
    .send({ content: JSON.stringify(payload) })
    .expect(200);
  return response.body.data as RestorePreviewResponse;
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
  userAId = (await prisma.user.findUniqueOrThrow({ where: { email: USER_A } })).id;
  userBId = (await prisma.user.findUniqueOrThrow({ where: { email: USER_B } })).id;
});

beforeEach(async () => {
  const userIds = [userAId, userBId];
  await prisma.habitCheckin.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.habitDefinition.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.winLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.waterLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.exerciseLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.mealLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.weightLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userSettings.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userGoal.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userProfile.deleteMany({ where: { userId: { in: userIds } } });
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

describe('R10.2 · POST /api/data/restore/preview + /restore', () => {
  it('选择文件只返回 6 类条数与整体跨度，不在预览阶段写入', async () => {
    const payload = validPayload({
      weights: [{ date: SAME_DATE, weightKg: 65, note: '' }],
      meals: [
        {
          date: NEW_DATE,
          mealType: 'lunch',
          items: [
            { name: '米饭', grams: 100, kcal: 116, proteinG: 2.6, fatG: 0.3, carbG: 25.9 },
            { name: '青菜', grams: 150, kcal: 45, proteinG: 2, fatG: 0.5, carbG: 7 },
          ],
        },
      ],
      wins: [{ date: NEW_DATE, text: '今天走路更轻松了' }],
    });

    const result = await preview(tokenA, payload);
    expect(result.schemaVersion).toBe(2);
    expect(result.counts).toEqual({ weights: 1, meals: 2, exercises: 0, habits: 0, water: 0, wins: 1 });
    expect(result.dateRange).toEqual({ from: SAME_DATE, to: NEW_DATE });
    expect(result.mergeStrategy).toBe('same-day-replace');
    expect(await prisma.weightLog.count({ where: { userId: userAId } })).toBe(0);
    expect(await prisma.mealLog.count({ where: { userId: userAId } })).toBe(0);
  });

  it('确认后同日覆盖、不同日追加，并保留备份未出现的日期', async () => {
    await prisma.weightLog.createMany({
      data: [
        { userId: userAId, loggedAt: UNTOUCHED_DATE, weightKg: 70 },
        { userId: userAId, loggedAt: SAME_DATE, weightKg: 99 },
      ],
    });
    await prisma.mealLog.createMany({
      data: [
        {
          userId: userAId,
          loggedDate: UNTOUCHED_DATE,
          mealType: 'breakfast',
          customName: '保留早餐',
          kcal: 100,
          source: 'quick_add',
        },
        {
          userId: userAId,
          loggedDate: SAME_DATE,
          mealType: 'lunch',
          customName: '原有午餐',
          kcal: 200,
          source: 'quick_add',
        },
      ],
    });
    await prisma.winLog.createMany({
      data: [
        { userId: userAId, loggedDate: UNTOUCHED_DATE, text: '保留这句' },
        { userId: userAId, loggedDate: SAME_DATE, text: '替换这句' },
      ],
    });

    const payload = validPayload({
      weights: [
        { date: SAME_DATE, weightKg: 65, note: '来自备份' },
        { date: NEW_DATE, weightKg: 64.8, note: '' },
      ],
      meals: [
        {
          date: SAME_DATE,
          mealType: 'dinner',
          items: [{ name: '备份晚餐', grams: 200, kcal: 180, proteinG: 10, fatG: 6, carbG: 20 }],
        },
      ],
      wins: [
        { date: SAME_DATE, text: '备份第一句' },
        { date: SAME_DATE, text: '备份第二句' },
      ],
    });
    const restorePreview = await preview(tokenA, payload);
    const response = await request(server as never)
      .post(`${API}/data/restore`)
      .set(auth(tokenA))
      .send({ previewToken: restorePreview.previewToken })
      .expect(200);

    expect(response.body.data.restored).toEqual({
      weights: 2,
      meals: 1,
      exercises: 0,
      habits: 0,
      water: 0,
      wins: 2,
    });
    const weights = await prisma.weightLog.findMany({ where: { userId: userAId }, orderBy: { loggedAt: 'asc' } });
    expect(weights.map((row) => [row.loggedAt, row.weightKg])).toEqual([
      [UNTOUCHED_DATE, 70],
      [SAME_DATE, 65],
      [NEW_DATE, 64.8],
    ]);

    const meals = await prisma.mealLog.findMany({ where: { userId: userAId }, orderBy: { loggedDate: 'asc' } });
    expect(meals.map((row) => [row.loggedDate, row.customName])).toEqual([
      [UNTOUCHED_DATE, '保留早餐'],
      [SAME_DATE, '备份晚餐'],
    ]);
    const wins = await prisma.winLog.findMany({ where: { userId: userAId }, orderBy: [{ loggedDate: 'asc' }, { id: 'asc' }] });
    expect(wins.map((row) => [row.loggedDate, row.text])).toEqual([
      [UNTOUCHED_DATE, '保留这句'],
      [SAME_DATE, '备份第一句'],
      [SAME_DATE, '备份第二句'],
    ]);
  });

  it('A 的预览凭据由 B 确认时返回 404，且不会写入 B 的账号', async () => {
    const restorePreview = await preview(
      tokenA,
      validPayload({ weights: [{ date: SAME_DATE, weightKg: 65, note: '' }] }),
    );
    const response = await request(server as never)
      .post(`${API}/data/restore`)
      .set(auth(tokenB))
      .send({ previewToken: restorePreview.previewToken })
      .expect(404);
    expect(response.body.error.code).toBe('E_NOTFOUND_RESTORE_PREVIEW');
    expect(await prisma.weightLog.count({ where: { userId: userBId } })).toBe(0);

    await request(server as never)
      .post(`${API}/data/restore`)
      .set(auth(tokenA))
      .send({ previewToken: restorePreview.previewToken })
      .expect(200);
    expect(await prisma.weightLog.count({ where: { userId: userAId } })).toBe(1);
  });

  it('不能读取的 JSON 与非预期结构返回 400 中性文案', async () => {
    for (const content of ['{', JSON.stringify({ hello: 'world' })]) {
      const response = await request(server as never)
        .post(`${API}/data/restore/preview`)
        .set(auth(tokenA))
        .send({ content })
        .expect(400);
      expect(response.body.error.code).toBe('E_VALID_RESTORE_PAYLOAD');
      expect(response.body.error.message).not.toMatch(/失败|损坏|无效|错误/);
    }
  });

  it('写入途中遇到当前版本没有对应项的运动时整体回滚', async () => {
    await prisma.weightLog.create({ data: { userId: userAId, loggedAt: SAME_DATE, weightKg: 71 } });
    const restorePreview = await preview(
      tokenA,
      validPayload({
        weights: [{ date: SAME_DATE, weightKg: 60, note: '不应留下' }],
        exercises: [
          { date: SAME_DATE, type: 'activity-not-present', met: 5, minutes: 30, kcalBurned: 150 },
        ],
      }),
    );

    const response = await request(server as never)
      .post(`${API}/data/restore`)
      .set(auth(tokenA))
      .send({ previewToken: restorePreview.previewToken })
      .expect(400);
    expect(response.body.error.code).toBe('E_VALID_RESTORE_PAYLOAD');

    const weight = await prisma.weightLog.findUniqueOrThrow({
      where: { userId_loggedAt: { userId: userAId, loggedAt: SAME_DATE } },
    });
    expect(weight.weightKg).toBe(71);
    expect(await prisma.userProfile.findUnique({ where: { userId: userAId } })).toBeNull();
    expect(await prisma.exerciseLog.count({ where: { userId: userAId } })).toBe(0);
  });
});
