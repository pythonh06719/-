/**
 * Agent 流式端到端测试（`POST /ai/agent/stream`，SSE）。
 *
 * 覆盖：
 * 1. 鉴权：未带令牌 → 401（且不是 SSE 响应，连接不开流）；
 * 2. SSE 响应头：`text/event-stream`；
 * 3. 事件序列：`start` → `step`（final 结论步骤）→ `done`，`done` 的 `answer` 来自脚本桩、
 *    `status` 为 `answered`；
 * 4. LLM 抛错 → Agent **优雅降级**（`done` + `status: 'failed'` + 降级文案），不 500、连接收尾；
 * 5. trace 已落库（可观测性：steps / tokens / durationMs）。
 *
 * ⚠️ 与 `agent.e2e.test.ts` 相同的机制：加载 `dist/**` 编译产物、
 * `overrideProvider(LLM_CHAT_WITH_TOOLS)` 注入**脚本化桩**（不联网、不花钱、确定性）。
 * ⚠️ 配色/主题审计走应用真实主题机制 —— 不要手动 `classList.add('dark')`（会与 React 竞态产生假阳性）。
 */

import 'reflect-metadata';

import { createRequire } from 'node:module';

import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppModule as AppModuleClass } from '../src/app.module';
import type { PrismaService as PrismaServiceClass } from '../src/prisma/prisma.service';

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

const API = '/api';
const USER = 'e2e-agent-stream@qinglife.test';
const ENDPOINT = `${API}/ai/agent/stream`;

const logSpy = vi.spyOn(Logger.prototype, 'log');

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

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let token = '';
let userId = 0;

/** 脚本化的一轮模型回复。 */
interface ScriptedReply {
  content?: string;
  toolCalls?: Array<{ name: string; args?: unknown }>;
}

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

function auth(value: string): { Authorization: string } {
  return { Authorization: `Bearer ${value}` };
}

async function cleanup(): Promise<void> {
  await prisma.aiTrace.deleteMany({ where: { user: { email: USER } } });
  await prisma.authVerificationCode.deleteMany({ where: { email: USER } });
  await prisma.user.deleteMany({ where: { email: USER } });
}

/** 解析 SSE 文本为事件数组（每条 `data: {json}`，空行分帧）。 */
function parseSse(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const frame of text.split('\n\n')) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
      } catch {
        /* 忽略坏帧 */
      }
    }
  }
  return events;
}

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

  await request(server as never).post(`${API}/auth/send-code`).send({ email: USER }).expect(200);
  const code = findCode(USER);
  const res = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email: USER, code })
    .expect(200);
  token = (res.body.data as { accessToken: string }).accessToken;
  const user = await prisma.user.findUnique({ where: { email: USER } });
  if (user === null) throw new Error('测试用户未创建');
  userId = user.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

describe('POST /ai/agent/stream（SSE）', () => {
  it('未带令牌 → 401，且响应不是 SSE', async () => {
    const res = await request(server as never).post(ENDPOINT).send({ question: '晚上吃什么' });
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).not.toContain('text/event-stream');
  });

  it('SSE 响应头正确，事件序列 start → step → done，答案来自脚本桩', async () => {
    useScript({ content: '今天晚餐建议吃清淡的，预算还够。' });

    const res = await request(server as never)
      .post(ENDPOINT)
      .set(auth(token))
      .send({ question: '晚上吃什么' })
      .expect(200);

    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.text);
    expect(events[0]?.type).toBe('start');
    expect(events.some((e) => e.type === 'step')).toBe(true);

    const done = events.find((e) => e.type === 'done') as
      | { type: string; status: string; answer: string; traceId: number }
      | undefined;
    expect(done).toBeDefined();
    expect(done?.status).toBe('answered');
    expect(String(done?.answer)).toContain('清淡');
    expect(typeof done?.traceId).toBe('number');
  });

  it('LLM 抛错 → Agent 优雅降级（done + status=failed + 降级文案），流正常收尾', async () => {
    // 让脚本桩自身抛错：模拟模型不可用（Agent 会把 LLM 失败转为降级文案，不 500）
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_CHAT_WITH_TOOLS)
      .useValue(
        async () => {
          throw new Error('llm_down');
        },
      )
      .compile();
    const throwingApp = moduleRef.createNestApplication();
    throwingApp.setGlobalPrefix('api');
    await throwingApp.init();
    const throwingServer = throwingApp.getHttpServer();

    try {
      const res = await request(throwingServer as never)
        .post(ENDPOINT)
        .set(auth(token))
        .send({ question: '晚上吃什么' })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/event-stream');
      const events = parseSse(res.text);
      const done = events.find((e) => e.type === 'done') as
        | { type: string; status: string; answer: string }
        | undefined;
      expect(done).toBeDefined();
      expect(done?.status).toBe('failed');
      // 降级文案（温和、不指责）
      expect(String(done?.answer)).toContain('稍后再问我一次');
    } finally {
      await throwingApp.close();
    }
  });

  it('trace 已落库（可观测性：steps / tokens / durationMs）', async () => {
    useScript({ content: '预算还够，晚餐可以吃。' });
    await request(server as never)
      .post(ENDPOINT)
      .set(auth(token))
      .send({ question: '晚上吃什么' })
      .expect(200);

    const traces = await prisma.aiTrace.findMany({ where: { userId }, orderBy: { id: 'desc' } });
    expect(traces.length).toBeGreaterThan(0);
    const trace = traces[0];
    if (trace === undefined) throw new Error('trace 未落库');
    expect(trace.status).toBe('answered');
    expect(trace.durationMs).toBeTypeOf('number');
  });
});
