/**
 * AI 助手端到端测试（三期 T05：R9.1~R9.6 / R3.7，vitest + supertest，真实启动 Nest + SQLite）。
 *
 * 覆盖（T05 行三期 DoD）：
 * 1. 未配置 key：daily-summary 返回 200 + `available: false, reason: 'ai_not_configured'`
 *    且携带规则兜底 insight（不得 500 / TC-24）；
 * 2. 限额（R9.4 / TC-45）：当日各 feature 行 SUM ≥ 50 → 429 `E_LIMIT_AI`；
 * 3. 医疗安全闸（R9.6 / TC-44）：命中医疗意图 → 固定就医回复 + `safetyFlag: true`，
 *    且**不消耗限额**；
 * 4. 食物识别（R3.7）：描述命中食物库 → 返回候选（含每 100g / 默认份量热量），
 *    且**不写 meal_logs**（TC-22/23）。
 *
 * ⚠️ 与 `api.e2e.test.ts` 相同的机制：加载 `dist/**` 编译产物（装饰器元数据）。
 *
 * ⚠️ 本文件**显式关闭 AI 总开关**（`AI_ENABLED=false`）：既确定性地覆盖「未配置 / 不可用」
 * 全链路（规则兜底），也确保测试**永不发起真实 LLM 请求**（避免花钱、避免网络抖动造成 flaky）。
 * 历史教训：此前本文件只假设"环境里没有 key"，一旦本地配了真实 key 用例即失败 ——
 * 测试必须在自身内部固定前置条件，不得依赖环境。
 */

import 'reflect-metadata';

import { createRequire } from 'node:module';

// 必须在创建应用之前设置：AI 开关在每次调用时读取环境变量（见 app-config.ts）
process.env.AI_ENABLED = 'false';

import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppModule as AppModuleClass } from '../src/app.module';
import type { PrismaService as PrismaServiceClass } from '../src/prisma/prisma.service';

const require = createRequire(import.meta.url);

const { Logger } = require('@nestjs/common') as typeof import('@nestjs/common');
const { Test } = require('@nestjs/testing') as typeof import('@nestjs/testing');
const request = require('supertest') as unknown as typeof import('supertest');
const { AppModule } = require('../dist/apps/api/src/app.module.js') as {
  AppModule: typeof AppModuleClass;
};
const { PrismaService } = require('../dist/apps/api/src/prisma/prisma.service.js') as {
  PrismaService: typeof PrismaServiceClass;
};
const { toLocalDateKey } = require('../dist/packages/core/src/index.js') as typeof import('@qsh/core');

const API = '/api';
const USER_AI = 'e2e-ai@qinglife.test';
const USER_LIMIT = 'e2e-ai-limit@qinglife.test';
const USER_DELETED = 'e2e-ai-deleted@qinglife.test';

const logSpy = vi.spyOn(Logger.prototype, 'log');

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;

let tokenAi = '';
let tokenLimit = '';
let userAiId = 0;
let userLimitId = 0;
let seededFoodId = 0;

const today = toLocalDateKey(new Date());

/** 从日志中提取某邮箱的 6 位验证码。 */
function findCode(email: string): string {
  const calls = logSpy.mock.calls as unknown as unknown[][];
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const line = (calls[index] ?? [])
      .map((arg) => (typeof arg === 'string' ? arg : ''))
      .join(' ');
    if (line.includes(email)) {
      const matched = /(\d{6})/.exec(line);
      if (matched && matched[1]) {
        return matched[1];
      }
    }
  }
  throw new Error(`未捕获到 ${email} 的验证码日志`);
}

/** 认证头。 */
function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** 清理测试用户（级联）与测试种子食物。 */
async function cleanup(): Promise<void> {
  await prisma.user.deleteMany({ where: { email: { in: [USER_AI, USER_LIMIT, USER_DELETED] } } });
  if (seededFoodId > 0) {
    await prisma.foodItem.deleteMany({ where: { id: seededFoodId } });
  }
}

/** 注册并返回令牌与用户 id。 */
async function register(email: string): Promise<{ token: string; userId: number }> {
  await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  const code = findCode(email);
  const res = await request(server as never).post(`${API}/auth/verify-code`).send({ email, code }).expect(200);
  const body = res.body.data as { accessToken: string; user: { id: number } };
  return { token: body.accessToken, userId: body.user.id };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();

  prisma = app.get(PrismaService);
  server = app.getHttpServer();

  await cleanup();
  seededFoodId = (
    await prisma.foodItem.create({
      data: {
        name: '清蒸鲈鱼e2e',
        aliases: JSON.stringify([]),
        category: '家常菜',
        kcalPer100g: 105,
        servingUnits: JSON.stringify([{ unit: '块', grams: 150, isDefault: true }]),
        defaultServingGrams: 150,
        source: 'builtin',
      },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await app?.close();
});

describe('AI 助手（三期 T05：R9.x / R3.7）', () => {
  it('未携带令牌访问 AI 端点 → 401', async () => {
    await request(server as never).post(`${API}/ai/daily-summary`).send({}).expect(401);
  });

  it('未配置 key：daily-summary 返回 available:false + 规则兜底 insight（TC-24，不 500）', async () => {
    const { token, userId } = await register(USER_AI);
    tokenAi = token;
    userAiId = userId;

    const res = await request(server as never)
      .post(`${API}/ai/daily-summary`)
      .set(auth(tokenAi))
      .send({})
      .expect(200);
    expect(res.body.error).toBeNull();

    const data = res.body.data as {
      available: boolean;
      reason?: string;
      mode: string;
      date: string;
      insight: { conclusion: string; basis: string[]; suggestion: string };
    };
    expect(data.available).toBe(false);
    expect(data.reason).toBe('ai_not_configured');
    expect(data.mode).toBe('rule');
    expect(data.date).toBe(today);
    // 规则兜底仍然基于真实数据生成（功能可演示）
    expect(data.insight.conclusion.length).toBeGreaterThan(0);
    expect(data.insight.suggestion.length).toBeGreaterThan(0);
    expect(Array.isArray(data.insight.basis)).toBe(true);
  });

  it('today-plan 未配置 key 同样返回规则兜底；再次调用命中缓存（cached: true）', async () => {
    const first = await request(server as never)
      .post(`${API}/ai/today-plan`)
      .set(auth(tokenAi))
      .send({})
      .expect(200);
    expect(first.body.data.available).toBe(false);
    expect(first.body.data.cached).toBe(false);

    const second = await request(server as never)
      .post(`${API}/ai/today-plan`)
      .set(auth(tokenAi))
      .send({})
      .expect(200);
    expect(second.body.data.cached).toBe(true);
  });

  it('食物识别：描述命中食物库 → 候选含每 100g / 默认份量热量，且不写 meal_logs（R3.7 / TC-22/23）', async () => {
    const res = await request(server as never)
      .post(`${API}/ai/recognize-food`)
      .set(auth(tokenAi))
      .send({ description: '中午吃了一块清蒸鲈鱼e2e' })
      .expect(200);
    expect(res.body.error).toBeNull();

    const data = res.body.data as {
      description: string;
      candidates: Array<{
        foodId: number;
        name: string;
        kcalPer100g: number;
        defaultServingGrams: number | null;
        servingKcal: number | null;
      }>;
    };
    expect(data.candidates.length).toBeGreaterThan(0);
    const matched = data.candidates.find((candidate) => candidate.name === '清蒸鲈鱼e2e');
    expect(matched).toBeDefined();
    expect(matched!.kcalPer100g).toBe(105);
    expect(matched!.defaultServingGrams).toBe(150);
    // 105 × 150 ÷ 100 = 157.5 → round 158（数字只来自食物库换算）
    expect(matched!.servingKcal).toBe(158);

    // 本端点绝不直接入库
    const mealCount = await prisma.mealLog.count({ where: { userId: userAiId } });
    expect(mealCount).toBe(0);
  });

  it('食物识别：空描述 → 400 E_VALID_AI_EMPTY', async () => {
    const res = await request(server as never)
      .post(`${API}/ai/recognize-food`)
      .set(auth(tokenAi))
      .send({ description: '   ' })
      .expect(400);
    expect(res.body.error.code).toBe('E_VALID_AI_EMPTY');
  });

  it('医疗安全闸：命中医疗意图 → 固定就医回复 + safetyFlag:true，且不消耗限额（R9.6 / TC-44）', async () => {
    const res = await request(server as never)
      .post(`${API}/ai/free-ask`)
      .set(auth(tokenAi))
      .send({ question: '我最近总是头晕，降压药要不要停？' })
      .expect(200);
    expect(res.body.error).toBeNull();

    const data = res.body.data as { answer: string; safetyFlag: boolean; mode: string; matchedFood: unknown };
    expect(data.safetyFlag).toBe(true);
    expect(data.mode).toBe('rule');
    expect(data.answer).toContain('医生');
    expect(data.answer).toContain('不做疾病诊断');
    expect(data.answer).toContain('不建议自行停药');
    expect(data.matchedFood).toBeNull();

    // 不计入正常回答：医疗兜底不消耗限额（当日 ai_usage 无 free_ask 行）
    const freeAskUsage = await prisma.aiUsage.findFirst({
      where: { userId: userAiId, feature: 'free_ask' },
    });
    expect(freeAskUsage).toBeNull();
  });

  it('自由提问「还能吃 X 吗」：热量数字来自食物库', async () => {
    const res = await request(server as never)
      .post(`${API}/ai/free-ask`)
      .set(auth(tokenAi))
      .send({ question: '今天还能吃清蒸鲈鱼e2e吗' })
      .expect(200);

    const data = res.body.data as {
      answer: string;
      safetyFlag: boolean;
      matchedFood: { name: string; kcalPer100g: number } | null;
    };
    expect(data.safetyFlag).toBe(false);
    expect(data.matchedFood).not.toBeNull();
    expect(data.matchedFood!.name).toBe('清蒸鲈鱼e2e');
    expect(data.matchedFood!.kcalPer100g).toBe(105);
    expect(data.answer).toContain('105');
  });

  it('限额：当日各 feature 行 SUM ≥ 50 → 429 E_LIMIT_AI（R9.4 / TC-45）', async () => {
    const { token, userId } = await register(USER_LIMIT);
    tokenLimit = token;
    userLimitId = userId;

    // 两个 feature 分行各 25（合计 50），验证 SUM 口径而非单行
    await prisma.aiUsage.create({
      data: { userId, usageDate: today, feature: 'free_ask', requestCount: 25 },
    });
    await prisma.aiUsage.create({
      data: { userId, usageDate: today, feature: 'food_recognize', requestCount: 25 },
    });

    const res = await request(server as never)
      .post(`${API}/ai/free-ask`)
      .set(auth(tokenLimit))
      .send({ question: '今天还能吃苹果吗' })
      .expect(429);
    expect(res.body.data).toBeNull();
    expect(res.body.error.code).toBe('E_LIMIT_AI');
  });

  it('医疗安全闸：心情低落等心境类词命中固定就医回复（QA BUG-P3-1，不消耗限额）', async () => {
    const before = await prisma.aiUsage.count({ where: { userId: userAiId, feature: 'free_ask' } });

    const res = await request(server as never)
      .post(`${API}/ai/free-ask`)
      .set(auth(tokenAi))
      .send({ question: '最近心情低落怎么办' })
      .expect(200);
    expect(res.body.error).toBeNull();

    const data = res.body.data as { answer: string; safetyFlag: boolean; reason?: string; mode: string };
    expect(data.safetyFlag).toBe(true);
    expect(data.reason).toBe('matched_medical_intent');
    expect(data.mode).toBe('rule');
    expect(data.answer).toContain('医生');

    // 医疗兜底不计入正常回答：free_ask 行数不变
    const after = await prisma.aiUsage.count({ where: { userId: userAiId, feature: 'free_ask' } });
    expect(after).toBe(before);
  });

  it('硬删除后旧 JWT 打任意端点 → 401 E_AUTH_INVALID_TOKEN（QA BUG-P3-3，鉴权层根治）', async () => {
    const { token } = await register(USER_DELETED);
    await request(server as never).delete(`${API}/data`).set(auth(token)).expect(200);

    // 用户已删除：带旧 token 请求带 FK 的普通端点不得 500
    const res = await request(server as never).get(`${API}/water`).set(auth(token)).expect(401);
    expect(res.body.data).toBeNull();
    expect(res.body.error.code).toBe('E_AUTH_INVALID_TOKEN');
  });
});
