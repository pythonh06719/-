/**
 * 周报「微量营养素」缺失值不得被当成 0（🔴 缺陷回归护栏）。
 *
 * ## 钉死的缺陷
 *
 * `GET /api/report/weekly` 的 `micronutrients[].dailyAvg` 此前把**「没查到」静默折叠成 0**：
 * `report.service.ts` 的 `value = (per100g) => (per100g ?? 0) * factor`
 * 于是缺失值参与求和、照常除以分母、照常渲染成一个「看起来很正常」的低数字。
 *
 * 方向错得很具体：10 项里有 5 项是 `atMost`（建议不超过），`0 ≤ 参考` 恒成立 →
 * 用户看到「达标 ✓」。**把「没查到」报成「吃得很健康」**，这在减重产品里是最不该错的一侧。
 *
 * 实测（本仓库 dev.db，1789 条食物）：
 *   fiber 72.8% 缺失 ｜ sugar 80.0% ｜ saturatedFat 65.7% ｜ magnesium 34.1%
 *   vitaminD 100% 缺失 ｜ b12 100% 缺失  ← 这两项**恒为 0**，即恒显示「0 µg 达标 ✓」
 *
 * ## `/why-numbers` ⑯ 已经承诺（代码要追上它，不是改它）
 *
 *   term="什么时候留空" value="脂肪或 SFA% 缺任一项 → 留空"
 *   term="合理性校验"   value="推算值必须 ≤ 总脂肪"  hint="否则判为数据异常，留空不显示"
 *
 * ## 口径（本文件逐条钉住）
 *
 * 1. 一条记录里某项营养素**全为 null** → `dailyAvg === null`（**不是 0**）；
 * 2. 推算值 > 总脂肪（脏数据，如 `fat=0, sfa=0.002`）→ 判异常 → `null`；
 * 3. **部分缺失不算缺失**：有值的照常算，缺失的那部分不贡献也不抹掉已有值；
 * 4. 有真实值时**必须照常显示** —— 绝不能把好数据一起干掉；
 * 5. 分母仍是「有饮食记录的天数」（与 `avgIntakeKcal` 同分母，见另见用例）。
 *
 * ⚠️ 与 `report-daily-avg-denominator.e2e.test.ts` 同机制：**加载 `dist/**` 编译产物**
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
/** 测试食物名的唯一前缀（清理只按此前缀删，绝不碰种子数据）。 */
const FOOD_KEYWORD = 'E2E-MNUL-';
/** 本用例专用的账号（换场景时复用同一个账号，只清它的饮食记录）。 */
const USER = 'e2e-mnul@qinglife.test';

const GRAMS_PER_DAY = 100;
/** 每天记 1 条 → 「有饮食记录的天数」固定为 1，日均即该条本身。 */
const LOGGED_DAYS = 1;

/** 有效数据：钙 200mg/100g、纤维 10g/100g、饱和脂肪 2g/100g、铁 5mg/100g、镁 30mg/100g。 */
const GOOD_CALCIUM = 200;
const GOOD_FIBER = 10;
const GOOD_SFA = 2;
const GOOD_IRON = 5;
const GOOD_MAGNESIUM = 30;
/** 脏数据：总脂肪 0、饱和脂肪 0.002 → 推算值 > 总脂肪，应判异常。 */
const DIRTY_FAT = 0;
const DIRTY_SFA = 0.002;

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let token = '';

/** 各测试食物的 id（键名固定，用 `Record` 读出来是 `number | undefined`，故断言前先取一次）。 */
const ids: Record<'good' | 'zero' | 'noSfa' | 'dirtySfa' | 'empty', number> = {
  good: 0,
  zero: 0,
  noSfa: 0,
  dirtySfa: 0,
  empty: 0,
};

const today = toLocalDateKey(new Date());

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

/**
 * 造一个测试食物。
 *
 * ⚠️ `nutrients` 里**没传的键一律落 null（= 无数据）**，因为本用例要验的就是「缺失」这条路径；
 * `fatGPer100g` 例外 —— 它在 schema 里是 `Float @default(0)`（非空），给 0 才是合法值。
 */
async function createFood(
  tag: string,
  nutrients: {
    fatGPer100g?: number;
    fiberGPer100g?: number | null;
    calciumMgPer100g?: number | null;
    saturatedFatGPer100g?: number | null;
    ironMgPer100g?: number | null;
    magnesiumMgPer100g?: number | null;
  },
): Promise<number> {
  const created = await prisma.foodItem.create({
    data: {
      name: `${FOOD_KEYWORD}${tag}`,
      namePinyin: null,
      aliases: JSON.stringify([]),
      category: '主食',
      kcalPer100g: 100,
      proteinGPer100g: 0,
      carbGPer100g: 0,
      // 非空列：没传就是 0（schema default）
      fatGPer100g: nutrients.fatGPer100g ?? 0,
      // 可空列：显式传 null 表示「该项无数据」（Prisma 对 `Float?` 接受 null）
      fiberGPer100g: nutrients.fiberGPer100g ?? null,
      calciumMgPer100g: nutrients.calciumMgPer100g ?? null,
      saturatedFatGPer100g: nutrients.saturatedFatGPer100g ?? null,
      ironMgPer100g: nutrients.ironMgPer100g ?? null,
      magnesiumMgPer100g: nutrients.magnesiumMgPer100g ?? null,
      servingUnits: JSON.stringify([{ unit: '克', grams: 100 }]),
      defaultServingGrams: 100,
      source: 'builtin',
      createdByUserId: null,
      isVerified: true,
    },
    select: { id: true },
  });
  return created.id;
}

async function logMeal(date: string, food: number, mealType = 'lunch'): Promise<void> {
  await request(server as never)
    .post(`${API}/meals`)
    .set(auth(token))
    .send({ mealType, foodId: food, grams: GRAMS_PER_DAY, loggedDate: date })
    .expect(200);
}

interface MicronutrientPayload {
  key: string;
  name: string;
  unit: string;
  /** 缺失时为 `null` —— 本用例的核心断言对象 */
  dailyAvg: number | null;
  reference: number;
  direction: string;
}

async function fetchMicronutrients(): Promise<MicronutrientPayload[]> {
  const res = await request(server as never)
    .get(`${API}/report/weekly`)
    .set(auth(token))
    .query({ endDate: today })
    .expect(200);
  return (res.body.data as { micronutrients: MicronutrientPayload[] }).micronutrients;
}

function pick(list: MicronutrientPayload[], key: string): MicronutrientPayload {
  const found = list.find((item) => item.key === key);
  if (found === undefined) {
    throw new Error(`响应里没有 ${key}（实际：${list.map((i) => i.key).join(',')}）`);
  }
  return found;
}

/** 清掉**本测试账号**的饮食记录（绝不动别人的数据）。 */
async function clearMeals(): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: USER }, select: { id: true } });
  if (user === null) {
    return;
  }
  await prisma.mealLog.deleteMany({ where: { userId: user.id } });
}

beforeAll(async () => {
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

  // ① 有效数据：五项都有真实值
  ids.good = await createFood('GOOD', {
    fatGPer100g: 10,
    fiberGPer100g: GOOD_FIBER,
    calciumMgPer100g: GOOD_CALCIUM,
    saturatedFatGPer100g: GOOD_SFA,
    ironMgPer100g: GOOD_IRON,
    magnesiumMgPer100g: GOOD_MAGNESIUM,
  });
  // ①b 合法测量值 0：钙确实是 0（不是查不到）→ 期望 0 而非 null
  ids.zero = await createFood('ZERO', {
    fatGPer100g: 0,
    fiberGPer100g: GOOD_FIBER,
    calciumMgPer100g: 0,
    saturatedFatGPer100g: 0,
  });
  // ② 饱和脂肪缺失（但钙/纤维有值）→ 只有饱和脂肪该是 null
  ids.noSfa = await createFood('NOSFA', {
    fatGPer100g: 10,
    fiberGPer100g: GOOD_FIBER,
    calciumMgPer100g: GOOD_CALCIUM,
    saturatedFatGPer100g: null,
  });
  // ③ 脏数据：SFA 推算值 > 总脂肪 → 应判异常
  ids.dirtySfa = await createFood('DIRTYSFA', {
    fatGPer100g: DIRTY_FAT,
    fiberGPer100g: GOOD_FIBER,
    calciumMgPer100g: GOOD_CALCIUM,
    saturatedFatGPer100g: DIRTY_SFA,
  });
  // ④ 全部缺失：饱和脂肪/钙/纤维都没有 → 三项都该是 null
  //    （`fatGPer100g` 是非空列，不传即 0）
  ids.empty = await createFood('EMPTY', {
    fiberGPer100g: null,
    calciumMgPer100g: null,
    saturatedFatGPer100g: null,
  });
});

afterAll(async () => {
  if (prisma !== undefined) {
    await clearMeals();
    await prisma.foodItem.deleteMany({ where: { name: { contains: FOOD_KEYWORD } } });
    await prisma.authVerificationCode.deleteMany({ where: { email: USER } });
    await prisma.user.deleteMany({ where: { email: USER } });
  }
  if (app !== undefined) {
    await app.close();
  }
});

describe('周报微量营养素：缺失值不得被当成 0（🔴 红线）', () => {
  it('★ 用例 1：食物的饱和脂肪无数据 → dailyAvg 为 null，不是 0', async () => {
    await clearMeals();
    await logMeal(today, ids.noSfa);

    const sfa = pick(await fetchMicronutrients(), 'saturatedFatG');

    // 这是本用例的核心：曾经这里是 0（然后被判「≤ 20 g 达标 ✓」）
    expect(sfa.dailyAvg).toBeNull();
    // 顺带钉住「不是 0」：显式断言不等于 0，避免有人改成 0.0001 之类糊弄过去
    expect(sfa.dailyAvg).not.toBe(0);
  });

  it('★ 用例 2：推算值 > 总脂肪（fat=0, sfa=0.002）→ 判异常，返回 null', async () => {
    await clearMeals();
    await logMeal(today, ids.dirtySfa);

    const sfa = pick(await fetchMicronutrients(), 'saturatedFatG');

    // 0.002 > 0 → 违反 /why-numbers ⑯ 的「推算值必须 ≤ 总脂肪」，应判异常留空
    expect(sfa.dailyAvg).toBeNull();
  });

  it('★ 用例 3：全部缺失（钙/纤维/饱和脂肪都无数据）→ 三项都留空', async () => {
    await clearMeals();
    await logMeal(today, ids.empty);

    const list = await fetchMicronutrients();

    expect(pick(list, 'saturatedFatG').dailyAvg).toBeNull();
    expect(pick(list, 'calciumMg').dailyAvg).toBeNull();
    expect(pick(list, 'fiberG').dailyAvg).toBeNull();
  });

  it('★ 用例 4（防误伤）：真实值必须照常显示，且不能被一起抹成 null', async () => {
    await clearMeals();
    await logMeal(today, ids.good);

    const list = await fetchMicronutrients();

    // 100g ×（每 100g 值），分母 = 1 天 → 日均即该条本身
    expect(pick(list, 'calciumMg').dailyAvg).toBe(GOOD_CALCIUM);
    expect(pick(list, 'fiberG').dailyAvg).toBe(GOOD_FIBER);
    expect(pick(list, 'saturatedFatG').dailyAvg).toBe(GOOD_SFA);
    // 铁 / 镁也在测试食物里给了真实值 → 必须照常有值。
    // 这一条是「防过度修复」的锚：若有人把整张表都改成 null，本行会先红。
    expect(pick(list, 'ironMg').dailyAvg).toBe(GOOD_IRON);
    expect(pick(list, 'magnesiumMg').dailyAvg).toBe(GOOD_MAGNESIUM);
  });

  it('★ 用例 4b：合法测量值 0 必须保留为 0，不能被当成缺失', async () => {
    await clearMeals();
    await logMeal(today, ids.zero);

    const list = await fetchMicronutrients();

    // 钙确实是 0（不是查不到）→ 0 是合法结果，必须与 null 区分开
    expect(pick(list, 'calciumMg').dailyAvg).toBe(0);
    expect(pick(list, 'calciumMg').dailyAvg).not.toBeNull();
  });

  it('★ 用例 5（部分缺失）：有值的照常算，缺失的那项单独留空，互不影响', async () => {
    await clearMeals();
    // 同一天同餐两样：一样三项工作全、一样饱和脂肪缺失
    await logMeal(today, ids.good, 'lunch');
    await logMeal(today, ids.noSfa, 'dinner');

    const list = await fetchMicronutrients();

    // 钙/纤维两项两样都有 → 2×GOOD（分母仍是 1 天）
    expect(pick(list, 'calciumMg').dailyAvg).toBe(GOOD_CALCIUM * 2);
    expect(pick(list, 'fiberG').dailyAvg).toBe(GOOD_FIBER * 2);
    // 饱和脂肪：一样有值一样没值 → 整个窗口算「不可信」→ 留空，而不是折半
    expect(pick(list, 'saturatedFatG').dailyAvg).toBeNull();
  });

  it('★ 用例 6（一致性）：整周无饮食记录时，日均留空而不是 0', async () => {
    await clearMeals();

    const list = await fetchMicronutrients();

    // 分母会兜底成 1，但没有任何记录 → 无从得知 → 必须留空
    expect(pick(list, 'calciumMg').dailyAvg).toBeNull();
    expect(pick(list, 'saturatedFatG').dailyAvg).toBeNull();
  });
});
