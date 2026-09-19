/**
 * Agent 确认接口（`/ai/agent/confirm`）并发安全回归测试（P0 修复的证据）。
 *
 * 缺陷背景（P0-2）：
 *   confirm 的朴素实现是「findFirst 读 trace → 检查 `!trace.pendingTool` → tool.run() 执行写
 *   → update 置空 pendingTool」。并发两次（用户双击 / 客户端重放 / 网络重试）时，两个请求
 *   都能通过「pendingTool 仍存在」的检查 → **两次都执行写操作**（例如重复记两餐）。
 *
 * 修复：解析出待办后先做**条件更新原子抢占**
 *   `updateMany({ where: { id, userId, pendingTool: { not: null } }, data: { pendingTool: null } })`，
 *   只有 count=1 的那次继续执行 tool.run()；count=0 → 409 `E_VALID_DUPLICATE`。
 *
 * 本文件用**真实接口 + 并发调用**验证：
 *   1. 并发两次 confirm → 恰好一次成功，另一次 400/409；
 *   2. 目标业务表（meal_logs）**只 +1**（而不是 +2）——这是缺陷是否真的被修好的直接证据；
 *   3. 正向回归：单次 confirm 仍成功、响应形状不变、pendingTool 被清空。
 *
 * 与 `agent.e2e.test.ts` 相同的机制：加载 `dist/**` 编译产物、用桩替换 LLM（永不联网）。
 */

import 'reflect-metadata';

import { createRequire } from 'node:module';

import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppModule as AppModuleClass } from '../src/app.module';
import type { PrismaService as PrismaServiceClass } from '../src/prisma/prisma.service';

// 必须在创建应用之前：Agent 依赖「已配置」判定，桩会替换掉真实网络调用
process.env.AI_ENABLED = 'true';
process.env.AI_API_KEY = 'test-key-not-used';
process.env.AI_BASE_URL = 'https://example.invalid/v1';
process.env.AI_MODEL = 'stub-model';

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
const { LLM_CHAT_WITH_TOOLS } = require('../dist/apps/api/src/ai/llm.client.js') as {
  LLM_CHAT_WITH_TOOLS: symbol;
};
const { toLocalDateKey } = require('../dist/packages/core/src/index.js') as typeof import('@qsh/core');

/** 脚本化的一轮模型回复。 */
interface ScriptedReply {
  content?: string;
  toolCalls?: Array<{ name: string; args?: unknown }>;
}

const API = '/api';
const USER_CC = 'e2e-agent-cc@qinglife.test';

const logSpy = vi.spyOn(Logger.prototype, 'log');

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;

let tokenCc = '';
let userIdCc = 0;
let seededFoodId = 0;
let callCount = 0;
let script: ScriptedReply[] = [];

/** 桩：按脚本逐轮返回，绝不联网。 */
const stubLlm = async () => {
  const reply = script[callCount] ?? { content: '（脚本已用尽）' };
  callCount += 1;
  return {
    content: reply.content ?? '',
    toolCalls: (reply.toolCalls ?? []).map((call, index) => ({
      id: `call_${callCount}_${index}`,
      type: 'function' as const,
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    })),
    tokenIn: 10,
    tokenOut: 5,
    finishReason: reply.toolCalls && reply.toolCalls.length > 0 ? 'tool_calls' : 'stop',
  };
};

function useScript(...replies: ScriptedReply[]): void {
  script = replies;
  callCount = 0;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** 从日志中提取某邮箱的 6 位验证码。 */
function findCode(email: string): string {
  const calls = logSpy.mock.calls as unknown as unknown[][];
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const line = (calls[index] ?? []).map((arg) => (typeof arg === 'string' ? arg : '')).join(' ');
    if (line.includes(email)) {
      const matched = /(\d{6})/.exec(line);
      if (matched?.[1]) {
        return matched[1];
      }
    }
  }
  throw new Error(`未在日志中找到 ${email} 的验证码`);
}

async function register(email: string): Promise<{ token: string; userId: number }> {
  await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  const code = findCode(email);
  const res = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email, code })
    .expect(200);
  const body = res.body.data as { accessToken: string; user: { id: number } };
  return { token: body.accessToken, userId: body.user.id };
}

async function cleanup(): Promise<void> {
  await prisma.aiTrace.deleteMany({ where: { user: { email: USER_CC } } });
  await prisma.mealLog.deleteMany({ where: { user: { email: USER_CC } } });
  await prisma.aiUsage.deleteMany({ where: { user: { email: USER_CC } } });
  await prisma.user.deleteMany({ where: { email: USER_CC } });
}

const today = toLocalDateKey(new Date());

/** 走真实 `/ai/agent` 接口生成一条「待确认」轨迹，返回 traceId。 */
async function createPendingTrace(): Promise<number> {
  useScript({ toolCalls: [{ name: 'log_meal', args: { foodId: seededFoodId, grams: 200, mealType: 'lunch' } }] });
  const res = await request(server as never)
    .post(`${API}/ai/agent`)
    .set(auth(tokenCc))
    .send({ question: '午餐吃了 200 克米饭，帮我记一下' })
    .expect(200);
  const data = res.body.data as { status: string; traceId: number; pending?: { tool: string } };
  expect(data.status).toBe('need_confirm');
  expect(data.pending?.tool).toBe('log_meal');
  return data.traceId;
}

const countMeals = () => prisma.mealLog.count({ where: { userId: userIdCc, loggedDate: today } });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LLM_CHAT_WITH_TOOLS)
    .useValue(stubLlm)
    .compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();

  prisma = app.get(PrismaService);
  server = app.getHttpServer();

  await cleanup();
  seededFoodId = (
    await prisma.foodItem.create({
      data: {
        name: '米饭（confirm 并发测试）',
        aliases: JSON.stringify([]),
        category: '主食',
        kcalPer100g: 116,
        servingUnits: JSON.stringify([{ unit: '碗', grams: 200, isDefault: true }]),
        defaultServingGrams: 200,
        source: 'builtin',
      },
    })
  ).id;

  const registered = await register(USER_CC);
  tokenCc = registered.token;
  userIdCc = registered.userId;
});

afterAll(async () => {
  await cleanup();
  await app?.close();
});

describe('Agent confirm 并发安全（P0-2：原子抢占，避免双写）', () => {
  it('并发两次确认 → 只有一次成功，另一次 400/409，业务表只 +1（不重复落库）', async () => {
    const traceId = await createPendingTrace();
    const before = await countMeals();
    // 记录并发前的 toolCalls（persistTrace 已把 pending 步计入 1 次）
    const toolCallsBefore = (await prisma.aiTrace.findUnique({ where: { id: traceId } }))?.toolCalls ?? 0;

    // 关键：两个请求**同时**发出（supertest Request 是 thenable，交给 allSettled 即并发触发）
    const [first, second] = await Promise.allSettled([
      request(server as never).post(`${API}/ai/agent/confirm`).set(auth(tokenCc)).send({ traceId }),
      request(server as never).post(`${API}/ai/agent/confirm`).set(auth(tokenCc)).send({ traceId }),
    ]);

    const statuses = [first, second].map((result) =>
      result.status === 'fulfilled' ? result.value.status : -1,
    );
    const okCount = statuses.filter((status) => status === 200).length;
    const rejected = statuses.filter((status) => status === 400 || status === 409);
    const loser = [first, second].find(
      (result) => result.status === 'fulfilled' && result.value.status !== 200,
    );

    // 断言 1：恰好一次成功
    expect(okCount).toBe(1);
    expect(rejected).toHaveLength(1);
    // 断言 2：失败方应是可读的客户端错误
    //   - 若两请求真并发（都读到 pendingTool）：落败方 count=0 → 409 E_VALID_DUPLICATE；
    //   - 若被调度成先完成再检查（另一请求已清空）：命中早期检查 → 400 E_VALID_INPUT。
    //   两种都是正确行为，故接受任一，且必须带可读的中文文案。
    if (loser && loser.status === 'fulfilled') {
      expect([400, 409]).toContain(loser.value.status);
      expect(['E_VALID_DUPLICATE', 'E_VALID_INPUT']).toContain(loser.value.body.error.code);
      expect(typeof loser.value.body.error.message).toBe('string');
    }

    // 断言 3（决定性证据）：目标业务表只多了一条记录，而非两条
    const after = await countMeals();
    expect(after).toBe(before + 1);

    // 断言 4：轨迹最终态为 answered、pendingTool 清空、toolCalls 只 +1（仅一次确认真正生效）
    const trace = await prisma.aiTrace.findUnique({ where: { id: traceId } });
    expect(trace?.status).toBe('answered');
    expect(trace?.pendingTool).toBeNull();
    expect(trace?.toolCalls).toBe(toolCallsBefore + 1);
  });

  it('正向回归：单次确认正常成功、清空 pendingTool，且顺序重复确认返回 400', async () => {
    const traceId = await createPendingTrace();
    const before = await countMeals();

    const res = await request(server as never)
      .post(`${API}/ai/agent/confirm`)
      .set(auth(tokenCc))
      .send({ traceId })
      .expect(200);

    // 对外响应形状保持不变
    const data = res.body.data as {
      status: string;
      answer: string;
      result: { logged: boolean };
      traceId: number;
    };
    expect(data.status).toBe('answered');
    expect(data.answer).toContain('已按你的确认记录完成');
    expect(data.result.logged).toBe(true);
    expect(data.traceId).toBe(traceId);

    // 落库 +1，pendingTool 已被清空
    expect(await countMeals()).toBe(before + 1);
    const trace = await prisma.aiTrace.findUnique({ where: { id: traceId } });
    expect(trace?.pendingTool).toBeNull();

    // 顺序重复确认（pendingTool 已为空）→ 可读的 400（既有行为保持）
    const again = await request(server as never)
      .post(`${API}/ai/agent/confirm`)
      .set(auth(tokenCc))
      .send({ traceId })
      .expect(400);
    expect(again.body.error.code).toBe('E_VALID_INPUT');
    // 且没有第二次落库
    expect(await countMeals()).toBe(before + 1);
  });
});
