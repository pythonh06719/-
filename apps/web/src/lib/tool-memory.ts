/**
 * 「我的常点」（C2）—— 外卖 / 饮品工具的档位记忆（lib/tool-memory.ts）。
 *
 * 只做两件事：
 * - `rememberToolChoice(tool, values)`：记下「今天用了这个档位」；
 * - `readRememberedChoice(tool, allowed)`：读出「最常用」的那组档位，供页面预选。
 *
 * 口径与裁剪全部下沉在 `@qsh/core`（`toolChoiceKey` / `recordToolChoice` / `pickRememberedChoice`），
 * 这里只负责 localStorage 的读写与**脏数据兜底**：缓存被手工改坏、
 * 结构版本不认识、字段类型不对时一律回落「没有记忆」，
 * 绝不抛错 —— 记忆只是省事，不能让工具本身打不开。
 *
 * ⚠️ **只记忆，不推荐、不排序给结论、不做营养评判**（AC-11.5.3）：
 * 这里没有任何热量 / 营养素输入，也不产出任何「更健康」的判断，
 * 更不会改动工具本身的估算输出（估算仍由 `@qsh/core` 的 `estimate*` 决定）。
 */

import {
  TOOL_MEMORY_VERSION,
  emptyToolChoiceMemory,
  pickRememberedChoice,
  recordToolChoice,
  type ToolChoiceEntry,
  type ToolChoiceMemory,
} from '@qsh/core';

import { CACHE_KEYS, cacheGet, cacheSet } from './local-cache';
import { todayKey } from './format';

/**
 * 把任意（可能被改坏的）缓存内容折成合法记忆。
 *
 * 策略是「能救就救，救不了就当没有」：逐条校验，坏条目直接丢弃，
 * 而不是整份作废 —— 一条脏数据不该把用户记住的所有档位一起清掉。
 */
function normalizeMemory(raw: unknown): ToolChoiceMemory {
  if (raw === null || typeof raw !== 'object') {
    return emptyToolChoiceMemory();
  }
  const candidate = raw as { version?: unknown; tools?: unknown };
  if (candidate.version !== TOOL_MEMORY_VERSION || candidate.tools === null || typeof candidate.tools !== 'object') {
    return emptyToolChoiceMemory();
  }

  const tools: Record<string, ToolChoiceEntry[]> = {};
  for (const [tool, list] of Object.entries(candidate.tools as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      continue;
    }
    const entries: ToolChoiceEntry[] = [];
    for (const item of list) {
      if (item === null || typeof item !== 'object') {
        continue;
      }
      const entry = item as { key?: unknown; values?: unknown; days?: unknown };
      if (typeof entry.key !== 'string' || entry.key.length === 0) {
        continue;
      }
      if (entry.values === null || typeof entry.values !== 'object') {
        continue;
      }
      const values: Record<string, string> = {};
      for (const [field, value] of Object.entries(entry.values as Record<string, unknown>)) {
        if (typeof value === 'string') {
          values[field] = value;
        }
      }
      const days = Array.isArray(entry.days)
        ? entry.days.filter((day): day is string => typeof day === 'string')
        : [];
      if (days.length === 0) {
        continue;
      }
      entries.push({ key: entry.key, values, days });
    }
    if (entries.length > 0) {
      tools[tool] = entries;
    }
  }

  return { version: TOOL_MEMORY_VERSION, tools };
}

/** 读取当前记忆（读不到 / 读坏 → 空记忆，绝不抛错）。 */
export function readToolMemory(): ToolChoiceMemory {
  return normalizeMemory(cacheGet<unknown>(CACHE_KEYS.toolChoices));
}

/**
 * 记下一次选择（按「今天」计一天；同一天重复选择不会重复计数）。
 *
 * 只在**用户真的改了档位**时调用 —— 打开页面时的预选不算「用过」，
 * 否则默认值会被自己不断强化，永远选不回来。
 */
export function rememberToolChoice(tool: string, values: Record<string, string>): void {
  const next = recordToolChoice(readToolMemory(), {
    tool,
    values,
    date: todayKey(),
  });
  cacheSet(CACHE_KEYS.toolChoices, next);
}

/**
 * 读出最常用的一组档位（没有记忆 / 记忆已失效 → `null`，由调用方回落到默认档位）。
 *
 * @param allowed 合法取值白名单：库里已经不存在的旧档位会被忽略，绝不拿它去预选。
 */
export function readRememberedChoice(
  tool: string,
  allowed: Record<string, readonly string[]>,
): Record<string, string> | null {
  return pickRememberedChoice(readToolMemory(), { tool, allowed });
}
