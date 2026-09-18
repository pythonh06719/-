import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
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
