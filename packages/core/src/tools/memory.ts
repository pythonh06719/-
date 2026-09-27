/**
 * 「我的常点」档位记忆（core/tools/memory.ts）—— C2。
 *
 * 与「常吃榜」（`core/food/frequency.ts`）**同一套频次口径**：
 * - 计**天数**而不是次数（同一天换着点好几次，也只算「今天点过」，QR-1 的口径）；
 * - 窗口 90 天；
 * - 并列时的 tie-break 完全一致：`天数` 降序 → `最近一天` 降序 → `key` 升序（结果永不跳动）。
 *
 * 与常吃榜**唯一的差别**是门槛：榜是「摆出来给你看」，要出现 ≥ 3 天才够格（否则宁可不显示）；
 * 常点是「帮你预选一下」，出现 1 天就该记住 —— 所以 `TOOL_MEMORY_MIN_DAYS = 1`。
 *
 * **只记忆，不推荐、不排序给结论、不做营养评判**（AC-11.5.3 的零评判约束在本模块同样成立）：
 * 本模块不输入任何热量 / 营养素，也不产出任何「更健康」的判断，
 * 它只回答一个问题：**你上次/最常用的是哪个档位**。
 *
 * 本模块零 IO、零依赖（K12）：localStorage 的读写在 `apps/web` 侧，
 * 排序与裁剪口径在这里（唯一真源）。
 */

/** 参与记忆的工具（目前只有有「品类 + 档位」选择的外卖 / 饮品）。 */
export type ToolMemoryId = 'takeout' | 'drink';

/** 一条被记住的选择。 */
export interface ToolChoiceEntry {
  /** 选择键（由 `toolChoiceKey` 生成，字段顺序无关） */
  key: string;
  /** 该次选择的档位快照（回读时用来预选） */
  values: Record<string, string>;
  /** 用过的日期键（`YYYY-MM-DD`，distinct 且升序） */
  days: string[];
}

/** 记忆整体结构（localStorage 里就是这一个 JSON）。 */
export interface ToolChoiceMemory {
  /** 结构版本（未来改结构时据此迁移，旧数据读不懂就回落默认值，不崩） */
  version: 1;
  /** 工具 id → 记住的选择列表 */
  tools: Record<string, ToolChoiceEntry[]>;
}

/** 结构版本（写入时固定为 1）。 */
export const TOOL_MEMORY_VERSION = 1;

/** 记忆的上限（防止 localStorage 被无限写大）。 */
export const TOOL_MEMORY_LIMITS = {
  /** 每条选择最多保留多少个日期（≈ 90 天窗口，天然就是上限） */
  daysPerChoice: 90,
  /** 每个工具最多记住多少种选择 */
  choicesPerTool: 12,
  /** 统计窗口（天，含今天），与常吃榜一致 */
  windowDays: 90,
} as const;

/**
 * 最低门槛（出现天数）：1 —— 点过一次就该记住。
 *
 * 与常吃榜的 3 天不同：榜是要「摆出来看」的结论，点得不够多就整块不显示；
 * 常点只是替你预选，第一次点完下次就帮你选好，反而更省事。
 */
export const TOOL_MEMORY_MIN_DAYS = 1;

/** 一天 = 86 400 000 ms（纯字符串日期键的加减，避免 Date 时区抖动）。 */
const MS_PER_DAY = 86_400_000;

/** 空记忆（读不到 / 读坏时的回落值）。 */
export function emptyToolChoiceMemory(): ToolChoiceMemory {
  return { version: TOOL_MEMORY_VERSION, tools: {} };
}

/**
 * 由一组档位值生成选择键：**字段顺序无关**（先点杯型还是先点糖度，得到同一个键）。
 *
 * 空值字段会被忽略 —— 「没选糖度」不该和「选了无糖」变成两条记录。
 */
export function toolChoiceKey(values: Record<string, string>): string {
  const parts: string[] = [];
  for (const field of Object.keys(values).sort()) {
    const value = values[field];
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    parts.push(`${field}=${trimmed}`);
  }
  return parts.join('&');
}

/** 日期键是否合法（`YYYY-MM-DD`，只做形状校验，不校验历法）。 */
function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 窗口起始日期键（含端点）：`today − (windowDays − 1)`。 */
function windowStart(today: string, windowDays: number): string {
  const parts = today.slice(0, 10).split('-').map((part) => Number(part));
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return today;
  }
  const end = Date.UTC(year, month - 1, day);
  const start = new Date(end - (windowDays - 1) * MS_PER_DAY);
  const mm = String(start.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(start.getUTCDate()).padStart(2, '0');
  return `${start.getUTCFullYear()}-${mm}-${dd}`;
}

/** 取最近一次使用的日期（升序数组的末位；空数组返回 ''）。 */
function lastDay(days: readonly string[]): string {
  return days.length === 0 ? '' : (days[days.length - 1] as string);
}

/** 日期去重 + 升序 + 裁窗口 + 裁条数（保留最近的）。 */
function tidyDays(dates: readonly string[], today: string): string[] {
  const from = windowStart(today, TOOL_MEMORY_LIMITS.windowDays);
  const unique = Array.from(new Set(dates.filter((date) => isDateKey(date))))
    .filter((date) => date >= from)
    .sort();
  return unique.slice(Math.max(0, unique.length - TOOL_MEMORY_LIMITS.daysPerChoice));
}

/** `recordToolChoice` 的入参。 */
export interface RecordToolChoiceInput {
  /** 工具 id（如 `takeout` / `drink`） */
  tool: string;
  /** 本次选择的档位（字段 → 值，值一律字符串化，杯型这类数字也存字符串） */
  values: Record<string, string>;
  /** 使用日期 `YYYY-MM-DD`（本地日期键） */
  date: string;
}

/**
 * 记下「今天用了这个档位」→ 返回**新的**记忆（纯函数，不改入参）。
 *
 * - 同一天重复记（换档位又换回来）只算 1 天，与常吃榜的「天数」口径一致；
 * - 日期非法 / 档位为空 → 原样返回（**绝不抛错**：记忆是锦上添花，不能拖垮工具本身）；
 * - 超出上限时按「最近用过」裁剪（最久没用、最久以前的日期先丢）。
 */
export function recordToolChoice(
  memory: ToolChoiceMemory,
  input: RecordToolChoiceInput,
): ToolChoiceMemory {
  const { tool, values, date } = input;
  if (typeof tool !== 'string' || tool.length === 0 || !isDateKey(date)) {
    return memory;
  }
  const key = toolChoiceKey(values ?? {});
  if (key.length === 0) {
    return memory;
  }

  const entries = memory?.tools?.[tool] ?? [];
  const existing = entries.find((entry) => entry.key === key);
  const days = tidyDays(
    existing !== undefined && existing.days.includes(date)
      ? existing.days
      : [...(existing?.days ?? []), date],
    date,
  );
  const entry: ToolChoiceEntry = {
    key,
    values: { ...values },
    days,
  };

  const next = [
    ...entries.filter((item) => item.key !== key),
    entry,
  ].sort((left, right) => {
    const leftLast = lastDay(left.days);
    const rightLast = lastDay(right.days);
    if (rightLast !== leftLast) {
      return rightLast < leftLast ? -1 : 1;
    }
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
  const trimmed = next.slice(0, TOOL_MEMORY_LIMITS.choicesPerTool);

  return {
    version: TOOL_MEMORY_VERSION,
    tools: { ...(memory?.tools ?? {}), [tool]: trimmed },
  };
}

/** `pickRememberedChoice` 的入参。 */
export interface PickRememberedChoiceInput {
  /** 工具 id */
  tool: string;
  /**
   * 合法的字段取值白名单（字段 → 可选值）。
   *
   * 作用是**过滤陈旧记忆**：库里下架了某个品类、或改了糖度档位名，
   * 记忆里那条就不再成立 —— 直接忽略，回落到默认档位，绝不拿一个不存在的选项去预选。
   */
  allowed: Record<string, readonly string[]>;
}

/**
 * 读出「最常用（天数最多）」的那组档位；没有记忆 / 记忆全部失效时返回 `null`。
 *
 * 排序与常吃榜同源：天数降序 → 最近一天降序 → key 升序（完全确定，不跳动）。
 * 只返回**值**，不含任何天数、热量或评价 —— 页面据此预选，不据此说教。
 */
export function pickRememberedChoice(
  memory: ToolChoiceMemory,
  input: PickRememberedChoiceInput,
): Record<string, string> | null {
  const { tool, allowed } = input;
  if (typeof tool !== 'string' || tool.length === 0) {
    return null;
  }
  const entries = memory?.tools?.[tool];
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  const candidates = entries.filter((entry) => {
    if (!Array.isArray(entry?.days) || entry.days.length < TOOL_MEMORY_MIN_DAYS) {
      return false;
    }
    for (const field of Object.keys(allowed ?? {})) {
      const options = allowed[field];
      const value = entry?.values?.[field];
      if (typeof value !== 'string' || !Array.isArray(options) || !options.includes(value)) {
        return false;
      }
    }
    return true;
  });

  const ranked = [...candidates].sort((left, right) => {
    if (right.days.length !== left.days.length) {
      return right.days.length - left.days.length;
    }
    const leftLast = lastDay(left.days);
    const rightLast = lastDay(right.days);
    if (rightLast !== leftLast) {
      return rightLast < leftLast ? -1 : 1;
    }
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });

  const top = ranked[0];
  return top === undefined ? null : { ...top.values };
}
