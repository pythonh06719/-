import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../common/decorators/current-user';
import { todayLocalKey } from '../common/utils/date.util';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import {
  AgentAskDto,
  AgentConfirmDto,
  DailySummaryDto,
  FreeAskDto,
  RecognizeFoodDto,
  TodayPlanDto,
} from './dto/ai.dto';
import { AgentService } from './agent.service';
import { toFreeAskResponse } from './agent-view';
import { AiService } from './ai.service';

/**
 * AI 助手控制器（`/api/ai/**`，三期 R9.1~R9.6 / R3.7）。
 *
 * - 全部鉴权（`userId` 一律取 JWT，K7）；响应统一 `{ data, error }`（K2）；
 * - key 仅服务端（R9.5）：请求 / 响应中不出现任何 AI 凭据；
 * - 所有端点 POST + 200（与其他写端点一致，QA BUG-P2-2 同口径）；
 * - **成本防线**：烧 token 的 5 个端点按**登录用户**限流 20 次 / 分钟
 *   （`UserThrottlerGuard`，避免 NAT 共享 IP 的用户互相误伤）；超限 → 429 `E_LIMIT_THROTTLE`。
 *   查询轨迹 / 确认写入不调用模型，沿用模块默认限额（300 次 / 分钟 / 用户）。
 */
@Controller('ai')
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly agentService: AgentService,
  ) {}

  /** 每日总结（R9.1）：当日复盘 = 直接结论 + 依据 + 一条可执行建议。 */
  @Post('daily-summary')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  dailySummary(@CurrentUser() userId: number, @Body() dto: DailySummaryDto) {
    return this.aiService.dailySummary(userId, dto);
  }

  /** 今日方案（R9.2）：据最近两日记录生成；数据未变则复用缓存（不计数）。 */
  @Post('today-plan')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  todayPlan(@CurrentUser() userId: number, @Body() dto: TodayPlanDto) {
    return this.aiService.todayPlan(userId, dto);
  }

  /**
   * 自由提问（R9.3）：**确定性优先，否则交给 Agent 工具链**。
   *
   * - 医疗意图 / 「还能吃 X 吗」等可确定性回答的语境 → 由 `AiService` 直接给出
   *   （数字来自食物库，可溯源）；
   * - 其余开放问题 → 交给 `AgentService.run`，让模型自己决定调用哪些工具（多步）。
   *
   * 编排放在控制器而非 Service 层：`AgentService` 已依赖 `AiService`（复用配额/记账），
   * 若反向依赖会形成循环依赖。
   */
  @Post('free-ask')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async freeAsk(@CurrentUser() userId: number, @Body() dto: FreeAskDto) {
    const deterministic = await this.aiService.freeAskDeterministic(userId, dto);
    if (deterministic !== null) {
      return deterministic;
    }

    const question = dto.question.trim();
    const date = dto.date ?? todayLocalKey();
    const run = await this.agentService.run(userId, question, date);
    return toFreeAskResponse(run, { date, question });
  }

  /**
   * 流式版自由提问（SSE）：与 `freeAsk` **同一套分流逻辑**，但 Agent 的多步过程实时推送。
   *
   * 事件（每条 `data: {json}\n\n`）：
   * - `start`：收到请求
   * - `step`：Agent 每完成一步（工具执行 / 注记 / 待确认 / 最终结论），形状同 `AgentStep`
   * - `done`：载荷与 `POST /ai/free-ask` 的响应**同形状**（AiFreeAskResponse）——
   *   前端渲染逻辑因此无需分叉；确定性回答（医疗安全闸 / 食物库命中）不产生 step，直接 done
   * - `error`：配额超限等异常（连接必收尾，绝不悬挂）
   */
  @Post('free-ask/stream')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  freeAskStream(
    @CurrentUser() userId: number,
    @Body() dto: FreeAskDto,
    @Res() res: Response,
  ): void {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const write = (event: Record<string, unknown>): void => {
      // ⚠️ 自吞写异常：客户端可能在流中途断开，对已销毁 socket 的 write 可能抛错 ——
      // 若让异常从 .catch() 的 error 写入再抛出，会变成**未处理的 Promise 拒绝**（Node 22 默认崩进程）。
      // 断开时忽略即可：run() 会自然跑完并把 trace 落库（可从 GET /ai/agent/traces 查看结果）。
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* 客户端已断开：忽略，等本轮 Agent 结束 */
      }
    };

    write({ type: 'start' });
    void this.aiService
      .freeAskDeterministic(userId, dto)
      .then(async (deterministic) => {
        if (deterministic !== null) {
          // 医疗安全闸 / 食物库命中：确定性回答，数字 100% 来自食物库
          write({ type: 'done', result: deterministic });
          return;
        }
        const question = dto.question.trim();
        const date = dto.date ?? todayLocalKey();
        const run = await this.agentService.run(userId, question, date, {
          onStep: (step) => write({ type: 'step', step }),
        });
        write({ type: 'done', result: toFreeAskResponse(run, { date, question }) });
      })
      .catch((error: unknown) => {
        // 配额超限 / 模型异常：明确告知前端降级，绝不悬挂连接
        const message = error instanceof Error ? error.message : 'free_ask_stream_failed';
        write({ type: 'error', message });
      })
      .finally(() => {
        res.end();
      });
  }

  /** 食物识别（R3.7）：文字描述 → 食物库候选；**不直接写 meal_logs**，需用户确认。 */
  @Post('recognize-food')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  recognizeFood(@CurrentUser() userId: number, @Body() dto: RecognizeFoodDto) {
    return this.aiService.recognizeFood(userId, dto);
  }

  // ---------------------------------------------------------------------------
  // Agent（P0）：模型自主调用领域工具的**多步**执行循环
  // ---------------------------------------------------------------------------

  /**
   * Agent 提问（P0）：由模型决定调用哪些工具（查食物 / 看板 / 运动换算 / 周报）。
   * 写操作（记一餐）不直接执行 —— 返回 `status: 'need_confirm'` 与待办卡片，
   * 由前端引导用户确认后调用 `/ai/agent/confirm`。
   */
  @Post('agent')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  agent(@CurrentUser() userId: number, @Body() dto: AgentAskDto) {
    return this.agentService.run(userId, dto.question, dto.date);
  }

  /**
   * 流式版 Agent（SSE）：把「正在做什么」实时推给前端，消除多步等待的干等。
   *
   * 事件（每条 `data: {json}\n\n`）：
   * - `start`：收到请求
   * - `step`：一个步骤完成（工具执行 / 注记 / 待确认 / 最终结论），形状同 `AgentStep`
   * - `done`：终态，字段与 `POST /ai/agent` 的响应体一致（status / answer / steps / …）
   * - `error`：配额超限等异常（前端展示降级文案；连接必收尾，绝不悬挂）
   *
   * 用 `@Res()` 接管响应：全局 ResponseInterceptor 不参与（SSE 不能包 `{ data, error }`），
   * 分块写入由本方法直接控制。鉴权与限流沿用类级守卫（JWT + 20 次/分钟）。
   */
  @Post('agent/stream')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  agentStream(
    @CurrentUser() userId: number,
    @Body() dto: AgentAskDto,
    @Res() res: Response,
  ): void {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // 显式 200：POST 默认 201，对 SSE 无意义
    res.status(200);
    res.flushHeaders?.();

    const write = (event: Record<string, unknown>): void => {
      // ⚠️ 自吞写异常：客户端可能在流中途断开，对已销毁 socket 的 write 可能抛错 ——
      // 若让异常从 .catch() 的 error 写入再抛出，会变成**未处理的 Promise 拒绝**（Node 22 默认崩进程）。
      // 断开时忽略即可：run() 会自然跑完并把 trace 落库（可从 GET /ai/agent/traces 查看结果）。
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* 客户端已断开：忽略，等本轮 Agent 结束 */
      }
    };

    write({ type: 'start' });
    this.agentService
      .run(userId, dto.question, dto.date, { onStep: (step) => write({ type: 'step', step }) })
      .then((result) => {
        write({ type: 'done', ...result });
      })
      .catch((error: unknown) => {
        // 模型不可用 / 配额超限等：明确告知前端降级，绝不悬挂连接
        const message = error instanceof Error ? error.message : 'agent_stream_failed';
        write({ type: 'error', message });
      })
      .finally(() => {
        res.end();
      });
  }

  /** 确认并执行 Agent 的待办写操作（human-in-the-loop 第二半）。 */
  @Post('agent/confirm')
  @HttpCode(HttpStatus.OK)
  agentConfirm(@CurrentUser() userId: number, @Body() dto: AgentConfirmDto) {
    return this.agentService.confirm(userId, dto.traceId);
  }

  /** 查看自己的 Agent 执行轨迹（可观测性：工具链 / 耗时 / token）。 */
  @Get('agent/traces')
  agentTraces(@CurrentUser() userId: number, @Query('limit') limit?: string) {
    return this.agentService.listTraces(userId, Number(limit ?? 20) || 20);
  }
}
