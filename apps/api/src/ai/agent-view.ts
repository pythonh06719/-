/**
 * Agent 视图映射：把 Agent 的运行结果翻译成既有 `/ai/free-ask` 的响应形状。
 *
 * 为什么单独一个纯函数文件：
 * - 让 **AiService 不依赖 AgentService**（AgentService 已依赖 AiService 复用配额，
 *   反向依赖会形成循环）——编排放在控制器，映射放在这里；
 * - 纯函数，易测，不碰 DI。
 */

import type { AiFreeAskResponse } from '@qsh/shared-types';

import type { AgentRunResult } from './agent.service';
import { AI_DISCLAIMER_NOTE } from './ai.constants';

/** 从轨迹里抽出实际调用过的工具名（按调用顺序）。 */
function toolsOf(run: AgentRunResult): string[] {
  return run.steps
    .filter((step) => step.type === 'tool' || step.type === 'pending')
    .map((step) => step.tool ?? '')
    .filter((tool) => tool.length > 0);
}

/**
 * 映射为 free-ask 响应。
 *
 * 语义约定：
 * - `answered` → `mode: 'llm'`（内容由模型组织，但数字来自工具）、附 `traceId/tools`；
 * - `need_confirm` → 同样返回文本，并带 `pending`（前端据此渲染确认按钮）；
 * - `disabled/failed/max_steps` → `available: false` + 明确原因，前端显示降级提示。
 */
export function toFreeAskResponse(
  run: AgentRunResult,
  context: { date: string; question: string },
): AiFreeAskResponse {
  const base = {
    date: context.date,
    question: context.question,
    answer: run.answer,
    safetyFlag: false,
    matchedFood: null,
  } satisfies Partial<AiFreeAskResponse>;

  if (run.status === 'answered' || run.status === 'need_confirm') {
    return {
      ...base,
      available: true,
      mode: 'llm',
      // 让用户知道「数字是怎么来的」，同时保留免责声明（与既有端点同一口径）
      answer: run.answer.includes(AI_DISCLAIMER_NOTE)
        ? run.answer
        : `${run.answer}\n（${AI_DISCLAIMER_NOTE}）`,
      traceId: run.traceId ?? undefined,
      pending: run.pending ? { tool: run.pending.tool, describe: run.pending.describe } : null,
      tools: toolsOf(run),
    };
  }

  const reason =
    run.status === 'disabled'
      ? 'ai_not_configured'
      : run.status === 'failed'
        ? 'ai_call_failed'
        : 'ai_max_steps';

  return {
    ...base,
    available: false,
    reason,
    mode: 'rule',
    traceId: run.traceId ?? undefined,
    tools: toolsOf(run),
  };
}
