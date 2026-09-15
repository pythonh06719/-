/**
 * Agent 端到端测试（P0：多步工具调用 / 写操作确认 / 降级 / 轨迹）。
 *
 * 设计要点（也是这套测试最有价值的地方）：
 * 1. **完全离线**：通过 `overrideProvider(LLM_CHAT_WITH_TOOLS)` 注入脚本化桩，
 *    测试**永不发起真实 LLM 请求** —— 确定性、零成本、不受网络抖动影响；
 * 2. 覆盖「模型想干什么」与「系统允不允许」两侧：
 *    - 模型侧：多步工具调用、未知工具、参数非法、步数失控；
 *    - 系统侧：写操作必须用户确认、越权确认 404、医疗意图不调用模型、AI 关闭时降级；
 * 3. 断言到**工具链轨迹**（steps）而不只是最终文案 —— 这正是 agent 应用最该测的部分。
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
const USER_AGENT = 'e2e-agent@qinglife.test';
const USER_OTHER = 'e2e-agent-other@qinglife.test';

const logSpy = vi.spyOn(Logger.prototype, 'log');

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;

let tokenAgent = '';
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
  await prisma.aiTrace.deleteMany({});
  await prisma.mealLog.deleteMany({});
  await prisma.aiUsage.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { in: [USER_AGENT, USER_OTHER] } } });
}

const today = toLocalDateKey(new Date());

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
        name: '米饭（agent 测试）',
        aliases: JSON.stringify([]),
        category: '主食',
        kcalPer100g: 116,
        servingUnits: JSON.stringify([{ unit: '碗', grams: 200, isDefault: true }]),
        defaultServingGrams: 200,
        source: 'builtin',
      },
    })
  ).id;

  const registered = await register(USER_AGENT);
  tokenAgent = registered.token;
});

afterAll(async () => {
  await cleanup();
  await app?.close();
});

describe('Agent（P0：多步工具调用 / 写操作确认 / 降级）', () => {
  it('未携带令牌 → 401', async () => {
    await request(server as never).post(`${API}/ai/agent`).send({ question: '你好' }).expect(401);
  });

  it('模型自主调用只读工具后给出结论（多步链路入库 + 轨迹完整）', async () => {
    useScript({ toolCalls: [{ name: 'get_today_status', args: {} }] }, { content: '今天还不错，继续保持。' });

    const res = await request(server as never)
      .post(`${API}/ai/agent`)
      .set(auth(tokenAgent))
      .send({ question: '我今天情况怎么样？' })
      .expect(200);

    const data = res.body.data as {
      status: string;
      answer: string;
      steps: Array<{ type: string; tool?: string }>;
      traceId: number;
      tokens: number;
    };
    expect(data.status).toBe('answered');
    expect(data.answer).toContain('继续保持');
    // 轨迹：1 次工具调用 + 1 步结论
    expect(data.steps.filter((step) => step.type === 'tool')).toHaveLength(1);
    expect(data.steps.some((step) => step.tool === 'get_today_status')).toBe(true);
    expect(data.tokens).toBeGreaterThan(0);

    const trace = await prisma.aiTrace.findUnique({ where: { id: data.traceId } });
    expect(trace?.status).toBe('answered');
    expect(trace?.toolCalls).toBe(1);
  });

  it('写操作不直接落库：返回待确认 → 确认后才写入（human-in-the-loop）', async () => {
    useScript({ toolCalls: [{ name: 'log_meal', args: { foodId: seededFoodId, grams: 150, mealType: 'lunch' } }] });

    const res = await request(server as never)
      .post(`${API}/ai/agent`)
      .set(auth(tokenAgent))
      .send({ question: `今天午餐吃了150克米饭，帮我记一下` })
      .expect(200);

    const data = res.body.data as {
      status: string;
      pending?: { tool: string; describe: string };
      traceId: number;
    };
    expect(data.status).toBe('need_confirm');
    expect(data.pending?.tool).toBe('log_meal');
    expect(data.pending?.describe).toContain('150');

    // 关键断言：确认之前**没有任何写入**
    expect(await prisma.mealLog.count({ where: { loggedDate: today } })).toBe(0);

    const confirmed = await request(server as never)
      .post(`${API}/ai/agent/confirm`)
      .set(auth(tokenAgent))
      .send({ traceId: data.traceId })
      .expect(200);
    expect((confirmed.body.data as { result: { logged: boolean } }).result.logged).toBe(true);

    const meals = await prisma.mealLog.count({ where: { loggedDate: today } });
    expect(meals).toBe(1);

    // 同一 trace 不能重复确认（pendingTool 已清空）
    await request(server as never)
      .post(`${API}/ai/agent/confirm`)
      .set(auth(tokenAgent))
      .send({ traceId: data.traceId })
      .expect(400);
  });

  it('越权：确认他人的待办 → 404（不泄露存在性）', async () => {
    useScript({ toolCalls: [{ name: 'log_meal', args: { foodId: seededFoodId, grams: 100, mealType: 'dinner' } }] });
    const res = await request(server as never)
      .post(`${API}/ai/agent`)
      .set(auth(tokenAgent))
      .send({ question: '晚餐记一份米饭 100 克' })
      .expect(200);
    const traceId = (res.body.data as { traceId: number }).traceId;

    const other = await register(USER_OTHER);
    await request(server as never)
      .post(`${API}/ai/agent/confirm`)
      .set(auth(other.token))
      .send({ traceId })
      .expect(404);
  });

  it('医疗意图：不调用模型（0 token），返回固定就医回复', async () => {
    useScript();
    const res = await request(server as never)
      .post(`${API}/ai/agent`)
      .set(auth(tokenAgent))
      .send({ question: '我最近头晕，是不是低血糖？该吃什么药' })
      .expect(200);

    const data = res.body.data as { status: string; tokens: number; answer: string };
    expect(data.status).toBe('answered');
    expect(data.tokens).toBe(0);
    expect(callCount).toBe(0);
    expect(data.answer).toContain('医生');
  });

  it('未知工具：把错误回灌给模型，模型自行纠正后仍能收敛', async () => {
    useScript({ toolCalls: [{ name: 'no_such_tool', args: {} }] }, { content: '换个方式回答你。' });

    const res = await request(server as never)
      .post(`${API}/ai/agent`)
      .set(auth(tokenAgent))
      .send({ question: '随便问问' })
      .expect(200);

    const data = res.body.data as { status: string; steps: Array<{ note?: string }> };
    expect(data.status).toBe('answered');
    expect(data.steps.some((step) => (step.note ?? '').includes('unknown_tool'))).toBe(true);
  });

  it('参数非法：工具返回可读错误，模型据此纠正（不 500）', async () => {
    useScript(
      { toolCalls: [{ name: 'log_meal', args: { foodId: seededFoodId, mealType: 'lunch' } }] },
      { content: '我需要克数才能记录。' },
    );

    const res = await request(server as never)
      .post(`${API}/ai/agent`)
      .set(auth(tokenAgent))
      .send({ question: '帮我记一份米饭' })
      .expect(200);

    const data = res.body.data as { status: string; steps: Array<{ note?: string }> };
    expect(data.status).toBe('answered');
    expect(data.steps.some((step) => (step.note ?? '').includes('失败'))).toBe(true);
  });

  it('步数失控：达到上限即停止（max_steps），不会无限循环', async () => {
    script = [];
    callCount = 0;
    // 让桩永远返回同一个工具调用（读工具，可执行 → 循环不会自然结束）
    const endless: ScriptedReply[] = Array.from({ length: 20 }, () => ({
      toolCalls: [{ name: 'get_today_status', args: {} }],
    }));
    useScript(...endless);

    const res = await request(server as never)
      .post(`${API}/ai/agent`)
      .set(auth(tokenAgent))
      .send({ question: '一直查' })
      .expect(200);

    const data = res.body.data as { status: string; steps: Array<{ type: string }> };
    expect(data.status).toBe('max_steps');
    expect(data.steps.filter((step) => step.type === 'tool')).toHaveLength(6);
  });

  it('AI 关闭（AI_ENABLED=false）：明确降级，不假装回答', async () => {
    process.env.AI_ENABLED = 'false';
    useScript({ content: '这条不应被使用' });

    const res = await request(server as never)
      .post(`${API}/ai/agent`)
      .set(auth(tokenAgent))
      .send({ question: '今天吃什么好' })
      .expect(200);

    const data = res.body.data as { status: string; answer: string };
    expect(data.status).toBe('disabled');
    expect(callCount).toBe(0);
    process.env.AI_ENABLED = 'true';
  });

  it('轨迹查询：只返回自己的记录（含工具链与耗时）', async () => {
    const res = await request(server as never)
      .get(`${API}/ai/agent/traces?limit=5`)
      .set(auth(tokenAgent))
      .expect(200);

    const rows = res.body.data as Array<{ id: number; steps: unknown[]; durationMs: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('durationMs');
    expect(Array.isArray(rows[0]?.steps)).toBe(true);
  });
});
