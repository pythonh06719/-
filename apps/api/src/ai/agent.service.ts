import { Inject, Injectable, Logger } from '@nestjs/common';

import { ApiException } from '../common/exceptions/api.exception';
import { ERROR_CODES } from '../common/constants/error-codes';
import { todayLocalKey } from '../common/utils/date.util';
import { DashboardService } from '../dashboard/dashboard.service';
import { ExerciseService } from '../exercise/exercise.service';
import { FoodsService } from '../foods/foods.service';
import { MealsService } from '../meals/meals.service';
import { ReportService } from '../report/report.service';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from './ai.service';
import {
  AI_DISCLAIMER_NOTE,
  AI_SYSTEM_PROMPT,
  MEDICAL_INTENT_KEYWORDS,
  MEDICAL_REPLY,
} from './ai.constants';
import { AgentToolError, createAgentTools } from './agent-tools';
import type { AgentTool, AgentToolContext } from './agent-tools';
import { LLM_CHAT_WITH_TOOLS } from './llm.client';
import type { LlmChatWithToolsFn, LlmMessage } from './llm.client';
import { isAiConfigured } from './llm.client';

/** Agent 单次运行最多允许的「模型-工具」往返步数（防失控与成本爆炸）。 */
export const AGENT_MAX_STEPS = 6;

/** 轨迹中的一步。 */
export interface AgentStep {
  index: number;
  type: 'tool' | 'pending' | 'final' | 'note';
  tool?: string;
  args?: unknown;
  /** 工具结果或结论摘要 */
  result?: string;
  note?: string;
  ms?: number;
}

export interface AgentPendingAction {
  tool: string;
  args: Record<string, unknown>;
  /** 给用户看的确认文案 */
  describe: string;
}

export interface AgentRunResult {
  status: 'answered' | 'need_confirm' | 'max_steps' | 'disabled' | 'failed';
  answer: string;
  steps: AgentStep[];
  tokens: number;
  durationMs: number;
  traceId: number | null;
  pending?: AgentPendingAction;
}

const DEGRADED_REPLY: Record<'disabled' | 'failed', string> = {
  disabled:
    '现在 AI 助手还没接上模型，你可以直接在饮食日记里记一笔，几秒钟就够；接上之后我再帮你算。',
  failed: '刚才和模型对话没成功（可能是网络或额度问题）。你可以稍后再问我一次，或直接在日记里记录。',
};

/**
 * Agent 服务（P0）：**手写执行循环**，让模型自己决定调用哪些领域工具。
 *
 * 与既有 `/ai/*` 端点的区别：
 * - 既有端点：服务端先把数据算好塞进 prompt，模型只负责「润色成话」（单轮，无工具）；
 * - 本服务：只给模型「工具清单 + 用户问题」，由模型决定调用顺序（多步），
 *   服务端负责执行工具、回灌观察结果，直到模型给出结论。
 *
 * 安全与工程约束（不因「让模型自主」而放松）：
 * 1. 医疗意图**先于模型**硬拦（复用同一套关键词与固定回复），命中即不调用模型；
 * 2. 写操作（记一餐）不直接执行 —— 回传待确认卡片，用户确认后才落库（human-in-the-loop）；
 * 3. 步数上限 `AGENT_MAX_STEPS`、单次工具超时与异常不抛出到客户端（回灌给模型自我纠正）；
 * 4. 模型不可用 / 调用失败 → 明确降级文案 + 状态，绝不 500；
 * 5. 每次都写 `ai_traces`（工具链 / 参数 / 耗时 / token），便于回放排查与后续评估。
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger('AgentService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly foods: FoodsService,
    private readonly meals: MealsService,
    private readonly dashboard: DashboardService,
    private readonly exercise: ExerciseService,
    private readonly report: ReportService,
    @Inject(LLM_CHAT_WITH_TOOLS) private readonly llm: LlmChatWithToolsFn,
  ) {}

  private buildSystemPrompt(dateKey: string): string {
    return [
      AI_SYSTEM_PROMPT,
      '',
      `今天是 ${dateKey}。`,
      '你可以调用工具来获取真实数据与执行操作，规则：',
      '1. 任何热量、剩余预算、消耗、周报数字，**必须来自工具返回**，绝不允许自己估算或编造；',
      '2. 用户提到具体食物但没给 id 时，先调 search_food 拿 id，再考虑 log_meal；',
      '2.1 只要问题涉及「今天 / 晚上 / 还能吃 / 建议吃什么」等当下安排，**先调 get_today_status**',
      '   拿到真实剩余额度再回答（个性化建议必须基于真实数据，不能泛泛而谈）；',
      '3. **只有用户明确要求记录时才调用 log_meal**（如「帮我记」「记一下」「记上」）；',
      '   用户只是陈述吃了什么、或问建议时，不要主动帮他记录 —— 记录用户数据必须由用户发起；',
      '   确认要记录时**必须直接调用 log_meal**（不要只在回复里描述）——',
      '   系统会自动把这次调用转成「待用户确认」卡片，不会直接落库，所以你尽管调用；',
      '   调用后简单说明你打算记什么即可（例如「准备记录：午餐 米饭 200g」）。',
      '4. 涉及疾病、用药、症状的问题不要给建议，直接建议就医（此情形已由系统前置拦截）；',
      '5. 回答控制在 3 句话以内，语气温和、不评判，不要出现「失败」「超标」这类责备性词。',
      AI_DISCLAIMER_NOTE,
    ].join('\n');
  }

  /** 执行一次 Agent 运行（可能返回「待确认」）。 */
  async run(userId: number, question: string, date?: string): Promise<AgentRunResult> {
    const started = Date.now();
    const dateKey = date ?? todayLocalKey();
    const steps: AgentStep[] = [];
    const trimmed = question.trim();

    // ① 医疗意图硬闸：与既有端点同一套关键词，命中即固定回复（不调用模型，也不消耗工具）
    if (MEDICAL_INTENT_KEYWORDS.some((keyword) => trimmed.includes(keyword))) {
      await this.ai.consumeQuota(userId, 'agent');
      const trace = await this.persistTrace(userId, trimmed, {
        status: 'answered',
        answer: MEDICAL_REPLY,
        steps: [{ index: 0, type: 'note', note: 'matched_medical_intent' }],
        tokens: 0,
        durationMs: Date.now() - started,
      });
      return {
        status: 'answered',
        answer: MEDICAL_REPLY,
        steps: [],
        tokens: 0,
        durationMs: Date.now() - started,
        traceId: trace.id,
      };
    }

    // ② 模型未配置：明确降级，不假装能回答
    if (!isAiConfigured()) {
      const trace = await this.persistTrace(userId, trimmed, {
        status: 'disabled',
        answer: DEGRADED_REPLY.disabled,
        steps: [{ index: 0, type: 'note', note: 'ai_not_configured' }],
        tokens: 0,
        durationMs: Date.now() - started,
      });
      return {
        status: 'disabled',
        answer: DEGRADED_REPLY.disabled,
        steps: [],
        tokens: 0,
        durationMs: Date.now() - started,
        traceId: trace.id,
      };
    }

    await this.ai.consumeQuota(userId, 'agent');

    const tools = createAgentTools({
      foods: this.foods,
      meals: this.meals,
      dashboard: this.dashboard,
      exercise: this.exercise,
      report: this.report,
    });
    const toolDefs = Object.values(tools).map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    const ctx: AgentToolContext = { userId, dateKey };
    const messages: LlmMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(dateKey) },
      { role: 'user', content: trimmed },
    ];

    let tokens = 0;
    let tokenIn = 0;
    let tokenOut = 0;
    let status: AgentRunResult['status'] = 'max_steps';
    let answer = '';
    let pending: AgentPendingAction | null = null;

    for (let index = 0; index < AGENT_MAX_STEPS; index += 1) {
      const stepStarted = Date.now();
      let reply;
      try {
        reply = await this.llm(messages, toolDefs);
      } catch (error) {
        // 模型不可用：降级但不 500（与既有 AI 端点同一原则）
        this.logger.warn(`agent_llm_failed: ${(error as Error).message}`);
        status = 'failed';
        answer = DEGRADED_REPLY.failed;
        steps.push({ index, type: 'note', note: 'llm_failed', ms: Date.now() - stepStarted });
        break;
      }

      tokenIn += reply.tokenIn;
      tokenOut += reply.tokenOut;
      tokens += reply.tokenIn + reply.tokenOut;

      // 没有工具调用 → 视为最终结论
      if (reply.toolCalls.length === 0) {
        answer = reply.content.trim();
        status = answer.length > 0 ? 'answered' : 'failed';
        if (!answer) {
          answer = DEGRADED_REPLY.failed;
        }
        steps.push({
          index,
          type: 'final',
          result: answer.slice(0, 200),
          ms: Date.now() - stepStarted,
        });
        break;
      }

      messages.push({
        role: 'assistant',
        content: reply.content ?? '',
        tool_calls: reply.toolCalls,
      });

      let stopForConfirm = false;
      for (const call of reply.toolCalls) {
        const name = call.function.name;
        const tool: AgentTool | undefined = tools[name];

        if (!tool) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name,
            content: JSON.stringify({ error: `没有名为 ${name} 的工具，请从工具清单中选择` }),
          });
          steps.push({ index, type: 'note', note: `unknown_tool:${name}` });
          continue;
        }

        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name,
            content: JSON.stringify({ error: '参数不是合法 JSON，请重新给出' }),
          });
          steps.push({ index, type: 'note', note: `bad_args:${name}` });
          continue;
        }

        // 写操作：不执行，停下等用户确认。
        // 但**先校验参数**（describe 内含校验）：参数不合法就回灌给模型纠正，
        // 绝不生成「食物 #undefined undefined 克」这类脏确认卡片。
        if (tool.write === true) {
          let describe: string;
          try {
            describe = tool.describe ? await tool.describe(args, ctx) : `${name} ${JSON.stringify(args)}`;
          } catch (error) {
            const message = error instanceof AgentToolError ? error.message : '参数不合法';
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name,
              content: JSON.stringify({ error: message }),
            });
            steps.push({
              index,
              type: 'tool',
              tool: name,
              args,
              note: `失败：${message}`,
              ms: Date.now() - stepStarted,
            });
            continue;
          }
          pending = { tool: name, args, describe };
          steps.push({
            index,
            type: 'pending',
            tool: name,
            args,
            note: describe,
            ms: Date.now() - stepStarted,
          });
          stopForConfirm = true;
          break;
        }

        try {
          const result = await tool.run(args, ctx);
          messages.push({ role: 'tool', tool_call_id: call.id, name, content: result.content });
          steps.push({
            index,
            type: 'tool',
            tool: name,
            args,
            result: result.content.slice(0, 300),
            ms: Date.now() - stepStarted,
          });
        } catch (error) {
          // 参数/业务错误回灌给模型，让它自我纠正（不中断循环）
          const message = error instanceof AgentToolError ? error.message : '工具执行失败';
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name,
            content: JSON.stringify({ error: message }),
          });
          steps.push({
            index,
            type: 'tool',
            tool: name,
            args,
            note: `失败：${message}`,
            ms: Date.now() - stepStarted,
          });
        }
      }

      if (stopForConfirm && pending) {
        status = 'need_confirm';
        answer = `我需要你确认一下：${pending.describe}。确认后我就记上。`;
        break;
      }
    }

    const durationMs = Date.now() - started;
    const trace = await this.persistTrace(userId, trimmed, {
      status,
      answer,
      steps,
      tokens,
      durationMs,
      pending,
    });
    if (tokenIn > 0 || tokenOut > 0) {
      await this.ai.recordTokens(userId, 'agent', { content: '', tokenIn, tokenOut });
    }

    return {
      status,
      answer,
      steps,
      tokens,
      durationMs,
      traceId: trace.id,
      ...(pending ? { pending } : {}),
    };
  }

  /**
   * 确认并执行待办写操作（human-in-the-loop 的第二半）。
   * 只能确认自己的轨迹，且只能确认 `pendingTool` 中记录的**那一次**调用 —— 防止被改参重放。
   */
  async confirm(userId: number, traceId: number): Promise<{
    status: 'answered';
    answer: string;
    result: unknown;
    traceId: number;
  }> {
    const trace = await this.prisma.aiTrace.findFirst({ where: { id: traceId, userId } });
    if (!trace) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_RESOURCE, '没有找到这次待确认的操作');
    }
    if (!trace.pendingTool) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '这次会话没有待确认的操作');
    }

    const pending = JSON.parse(trace.pendingTool) as AgentPendingAction;
    const tools = createAgentTools({
      foods: this.foods,
      meals: this.meals,
      dashboard: this.dashboard,
      exercise: this.exercise,
      report: this.report,
    });
    const tool = tools[pending.tool];
    if (!tool || tool.write !== true) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '该操作不支持确认执行');
    }

    const ctx: AgentToolContext = { userId, dateKey: todayLocalKey() };
    const result = await tool.run(pending.args, ctx);

    const steps = JSON.parse(trace.steps) as AgentStep[];
    steps.push({ index: steps.length, type: 'tool', tool: pending.tool, args: pending.args, result: result.content });

    await this.prisma.aiTrace.update({
      where: { id: trace.id },
      data: {
        status: 'answered',
        answer: '已按你的确认记录完成。',
        steps: JSON.stringify(steps),
        pendingTool: null,
        toolCalls: { increment: 1 },
      },
    });

    return {
      status: 'answered',
      answer: '已按你的确认记录完成。',
      result: result.data ?? JSON.parse(result.content),
      traceId: trace.id,
    };
  }

  /** 最近若干条轨迹（自己的），用于调试页与后续评估。 */
  async listTraces(userId: number, limit = 20) {
    const rows = await this.prisma.aiTrace.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      take: Math.min(Math.max(limit, 1), 50),
    });
    return rows.map((row) => ({
      id: row.id,
      question: row.question,
      status: row.status,
      answer: row.answer,
      toolCalls: row.toolCalls,
      tokens: row.tokens,
      durationMs: row.durationMs,
      createdAt: row.createdAt,
      steps: JSON.parse(row.steps) as AgentStep[],
      pending: row.pendingTool ? (JSON.parse(row.pendingTool) as AgentPendingAction) : null,
    }));
  }

  private async persistTrace(
    userId: number,
    question: string,
    payload: {
      status: string;
      answer: string;
      steps: AgentStep[];
      tokens: number;
      durationMs: number;
      pending?: AgentPendingAction | null;
    },
  ) {
    return this.prisma.aiTrace.create({
      data: {
        userId,
        question,
        status: payload.status,
        answer: payload.answer,
        steps: JSON.stringify(payload.steps),
        pendingTool: payload.pending ? JSON.stringify(payload.pending) : null,
        toolCalls: payload.steps.filter((step) => step.type === 'tool' || step.type === 'pending').length,
        tokens: payload.tokens,
        durationMs: payload.durationMs,
      },
    });
  }
}
