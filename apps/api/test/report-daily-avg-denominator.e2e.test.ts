/**
 * 周报「日均」同分母端到端测试（缺陷收尾 · 口径统一 + NFR-11）。
 *
 * ## 钉死的缺陷
 *
 * `GET /api/report/weekly` 里此前有两个都叫「日均」的数字，分母却不同：
 * - `avgIntakeKcal` 除以**有饮食记录的天数**；
 * - `micronutrients[].dailyAvg` **固定除以 7**（含没记录的日子）。
 *
 * 结果：一周只记了 3 天饮食的用户，「日均摄入」按 3 天算、钙铁纤维「日均」按 7 天算 ——
 * 后者约为真实值的 3/7，看起来像「几乎没吃什么」。同一张卡上同一个词必须同义。
 *
 * 本用例造「3 天有记录 + 4 天空」的数据，直接验证：
 * - `avgIntakeKcal` = 合计 ÷ 3；
 * - `micronutrients`（钙 / 纤维）= 合计 ÷ 3；
 * - 反推两者的**分母一致**（都等于 3，不是 7）。
 *
 * ⚠️ 与 `r11-new.e2e.test.ts` 同机制：**加载 `dist/**` 编译产物**
 * （esbuild 不生成 NestJS 依赖注入所需的装饰器元数据），改 `report.service.ts` 后须先 `nest build`。
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
const USER = 'e2e-dailyavg@qinglife.test';
/** 测试食物名的唯一前缀（清理只按此前缀删，绝不碰种子数据）。 */
const FOOD_KEYWORD = 'E2E-DENOM-';

/** 每天记 1 条：100g / 100kcal；食物每 100g 含钙 200mg、纤维 10g。 */
const GRAMS_PER_DAY = 100;
const KCAL_PER_DAY = 100;
const CALCIUM_PER_DAY = 200;
const FIBER_PER_DAY = 10;
/** 「有饮食记录的天数」——本用例刻意只记 3 天（另外 4 天空着）。 */
const LOGGED_DAYS = 3;

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let token = '';
let foodId = 0;

const today = toLocalDateKey(new Date());

/** `YYYY-MM-DD` 加减天数（本地时区）。 */
function shiftDays(from: string, delta: number): string {
  const [year, month, day] = from.slice(0, 10).split('-').map((part) => Number(part));
  const date = new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() + delta);
  return toLocalDateKey(date);
}

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

/** 记一条食物库条目的饮食（按克数重算热量与微量营养素，服务端口径）。 */
async function logMeal(date: string): Promise<void> {
  await request(server as never)
    .post(`${API}/meals`)
    .set(auth(token))
    .send({ mealType: 'lunch', foodId, grams: GRAMS_PER_DAY, loggedDate: date })
    .expect(200);
}

beforeAll(async () => {
  // 自用模式：让 `/auth/send-code` 回显验证码（不依赖 .env，避免假阴性）
  process.env.AUTH_LOG_CODE = 'true';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  server = app.getHttpServer();
  prisma = moduleRef.get<PrismaServiceClass>(PrismaService);

  await prisma.foodItem.deleteMany({ where: { name: { contains: FOOD_KEYWORD } } });
  await prisma.authVerificationCode.deleteMany({ where: { email: USER } });
  await prisma.user.deleteMany({ where: { email: USER } });

  token = await login(USER);

  const food = await prisma.foodItem.create({
    data: {
      name: `${FOOD_KEYWORD}钙源`,
      namePinyin: null,
      aliases: JSON.stringify([]),
      category: '主食',
      kcalPer100g: 100,
      proteinGPer100g: 0,
      fatGPer100g: 0,
      carbGPer100g: 0,
      fiberGPer100g: FIBER_PER_DAY,
      calciumMgPer100g: CALCIUM_PER_DAY,
      servingUnits: JSON.stringify([{ unit: '克', grams: 100 }]),
      defaultServingGrams: 100,
      source: 'builtin',
      createdByUserId: null,
      isVerified: true,
    },
    select: { id: true },
  });
  foodId = food.id;

  // 3 天有记录、4 天空（窗口为中位 today 往前 7 天）
  for (let offset = 0; offset < LOGGED_DAYS; offset += 1) {
    await logMeal(shiftDays(today, -offset));
  }
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.foodItem.deleteMany({ where: { name: { contains: FOOD_KEYWORD } } });
    await prisma.authVerificationCode.deleteMany({ where: { email: USER } });
    await prisma.user.deleteMany({ where: { email: USER } });
  }
  if (app !== undefined) {
    await app.close();
  }
});

describe('周报两处「日均」同分母（缺陷收尾）', () => {
  it('★ 3 天有记录时，avgIntakeKcal 与 micronutrients[].dailyAvg 都除以 3（不是 7）', async () => {
    const res = await request(server as never)
      .get(`${API}/report/weekly`)
      .query({ endDate: today })
      .set(auth(token))
      .expect(200);

    const data = res.body.data as {
      days: Array<{ intakeKcal: number }>;
      avgIntakeKcal: number;
      micronutrients: Array<{ key: string; dailyAvg: number; reference: number; direction: string }>;
    };

    // 先确认窗口内确实只有 3 天有饮食记录（前置条件守卫）
    const intakeDays = data.days.filter((day) => day.intakeKcal > 0).length;
    expect(intakeDays).toBe(LOGGED_DAYS);

    // 摄入：合计 300 ÷ 3 = 100（若仍 ÷7 会得到 ≈42.9）
    expect(data.avgIntakeKcal).toBe(KCAL_PER_DAY);

    const calcium = data.micronutrients.find((item) => item.key === 'calciumMg');
    const fiber = data.micronutrients.find((item) => item.key === 'fiberG');
    expect(calcium).toBeDefined();
    expect(fiber).toBeDefined();

    // 钙：合计 600 ÷ 3 = 200（若 ÷7 会得到 ≈85.71）
    expect(calcium?.dailyAvg).toBe(CALCIUM_PER_DAY);
    // 纤维：合计 30 ÷ 3 = 10（若 ÷7 会得到 ≈4.29）
    expect(fiber?.dailyAvg).toBe(FIBER_PER_DAY);

    // ★ 硬要求：两处「日均」的分母一致（都由合计反推分母，必须相等且等于 3）
    const intakeDenominator = (KCAL_PER_DAY * LOGGED_DAYS) / data.avgIntakeKcal;
    const calciumDenominator = (CALCIUM_PER_DAY * LOGGED_DAYS) / (calcium?.dailyAvg ?? 1);
    expect(intakeDenominator).toBe(calciumDenominator);
    expect(intakeDenominator).toBe(LOGGED_DAYS);
  });
});
