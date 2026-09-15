/**
 * LLM 客户端（三期，R9.5 / ARCHITECTURE §1.8）。
 *
 * - key **仅存在于服务端环境变量**（`AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL`），
 *   读取自 `config/app-config.ts` 的统一配置；**绝不打日志、绝不出现在响应体**（TC-45）。
 * - 零新依赖：用 Node 原生 `fetch` 调 OpenAI 兼容 `chat/completions` 格式。
 * - key 未配置 → `isConfigured() === false`，上层走规则兜底生成器；
 *   key 已配置但调用失败 → 抛出异常，由上层捕获后降级到规则兜底，**绝不 500**。
 */

import {
  AI_MAX_OUTPUT_TOKENS,
  AI_REQUEST_TIMEOUT_MS,
} from './ai.constants';
import { getAppConfig } from '../config/app-config';

/** OpenAI 兼容的消息结构（含 function calling 所需的 tool 角色与 tool_calls）。 */
export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role=assistant 时可能携带的工具调用请求 */
  tool_calls?: LlmToolCall[];
  /** role=tool 时对应哪次调用 */
  tool_call_id?: string;
  /** role=tool 时的工具名（便于调试与轨迹记录） */
  name?: string;
}

/** 带工具的一次往返结果（Agent 循环用）。 */
export interface LlmToolChatResult {
  content: string;
  toolCalls: LlmToolCall[];
  tokenIn: number;
  tokenOut: number;
  finishReason: string;
}

/**
 * 注入令牌：Agent 循环通过它调用 LLM。
 * 抽成 provider 的目的是让 e2e 测试能替换为**脚本化桩**，
 * 从而在不联网、不花钱的前提下确定性地验证「多步工具调用」路径。
 */
export const LLM_CHAT_WITH_TOOLS = Symbol('LLM_CHAT_WITH_TOOLS');

export type LlmChatWithToolsFn = (
  messages: LlmMessage[],
  tools: Array<Record<string, unknown>>,
) => Promise<LlmToolChatResult>;

/** LLM 调用结果（含 token 用量，落 `ai_usage` 供 R9.4 限额统计）。 */
export interface LlmCompletion {
  /** 首选返回的文本内容 */
  content: string;
  /** 输入 token 数（响应缺失时为 0） */
  tokenIn: number;
  /** 输出 token 数（响应缺失时为 0） */
  tokenOut: number;
}

/** 服务端 AI 配置（key 不外泄：本接口仅在服务端模块内部使用）。 */
export interface AiRuntimeConfig {
  /** 总开关（`AI_ENABLED=false` 时强制走规则兜底） */
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** 读取 AI 配置（每次读取现取环境变量，便于测试注入 / 热更新）。 */
export function getAiRuntimeConfig(): AiRuntimeConfig {
  const config = getAppConfig();
  return {
    enabled: config.ai.enabled,
    apiKey: config.ai.apiKey,
    baseUrl: config.ai.baseUrl,
    model: config.ai.model,
  };
}

/** key 是否已配置（开关打开且三者齐备才视为可用）。 */
export function isAiConfigured(config: AiRuntimeConfig = getAiRuntimeConfig()): boolean {
  return (
    config.enabled &&
    config.apiKey.trim().length > 0 &&
    config.baseUrl.trim().length > 0 &&
    config.model.trim().length > 0
  );
}

/**
 * 从返回文本中提取 JSON（容忍 ```json 代码围栏与前后杂文）。
 * 解析失败返回 `null`，由上层降级到规则兜底。
 */
export function extractJson<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** 调用 LLM（OpenAI 兼容 `POST {baseUrl}/chat/completions`）。失败抛异常，由上层降级。 */
export async function chatCompletion(
  config: AiRuntimeConfig,
  messages: LlmMessage[],
  jsonMode = true,
): Promise<LlmCompletion> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // key 仅出现在服务端发出的请求头中（R9.5），不打日志、不回传客户端
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.6,
      max_tokens: AI_MAX_OUTPUT_TOKENS,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // 只记录状态码，不记录请求体（可能含 key 相关上下文）
    throw new Error(`ai_llm_request_failed_status_${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = payload.choices?.[0]?.message?.content ?? '';
  if (content.trim().length === 0) {
    throw new Error('ai_llm_empty_response');
  }

  return {
    content,
    tokenIn: payload.usage?.prompt_tokens ?? 0,
    tokenOut: payload.usage?.completion_tokens ?? 0,
  };
}

/**
 * 带工具的一次 LLM 往返（Agent 循环的「一步」）。
 *
 * 与 `chatCompletion` 的区别：
 * - 不使用 `response_format: json_object`（部分模型的工具调用与 JSON 模式不兼容）
 * - 返回完整的 assistant 消息（可能既有 content 又有 tool_calls）
 * - 失败同样抛异常，由 Agent 循环降级为规则兜底（绝不 500）
 */
export async function chatWithTools(
  config: AiRuntimeConfig,
  messages: LlmMessage[],
  tools: Array<Record<string, unknown>>,
): Promise<LlmToolChatResult> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // key 仅出现在服务端请求头（R9.5），不打日志、不回传客户端
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.3,
      max_tokens: AI_MAX_OUTPUT_TOKENS,
      ...(tools.length > 0 ? { tools } : {}),
    }),
    signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`ai_llm_request_failed_status_${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: LlmToolCall[] };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = payload.choices?.[0];
  return {
    content: choice?.message?.content ?? '',
    toolCalls: choice?.message?.tool_calls ?? [],
    tokenIn: payload.usage?.prompt_tokens ?? 0,
    tokenOut: payload.usage?.completion_tokens ?? 0,
    finishReason: choice?.finish_reason ?? 'unknown',
  };
}
