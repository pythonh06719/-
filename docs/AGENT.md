# Agent 设计说明（P0）

> 本文说明 `/api/ai/agent` 的**执行循环**、工具层与安全边界。它是「让模型自己决定用哪些工具」的实现，
> 与既有的 `/api/ai/daily-summary`、`/today-plan`、`/free-ask`（服务端先算好数据、模型只做措辞润色）本质不同。

## 1. 为什么不是一个 prompt 调用

| 维度 | 既有 AI 端点 | Agent 端点 |
| --- | --- | --- |
| 数据获取 | 服务端预先查询后塞进 prompt | **模型自己决定查什么、按什么顺序查** |
| 步数 | 固定 1 轮 | 最多 6 轮（`AGENT_MAX_STEPS`） |
| 可执行动作 | 无 | 5 个工具（含 1 个写操作） |
| 失败处理 | 直接降级 | 工具错误**回灌给模型**自我纠正 |
| 可观测 | 仅 token 计数 | 全链路轨迹（工具/参数/耗时/token）落库 |

## 2. 执行循环（`apps/api/src/ai/agent.service.ts`）

```
用户问题 ─┬─► 医疗意图关键词命中？ ──是──► 固定就医回复（不调用模型、0 token）
          │
          └─► 模型未配置 / AI_ENABLED=false ──► 明确降级文案（不假装回答）
                    │否
                    ▼
        ┌──► 调用 LLM（携带 5 个工具定义）
        │         │
        │         ├─ 无 tool_calls ──► 作为最终结论（status=answered）
        │         │
        │         └─ 有 tool_calls ──► 逐个处理：
        │                ├─ 只读工具 ──► 执行 ──► 结果作为 role=tool 消息回灌
        │                ├─ 写工具   ──► 先校验参数 ──► 生成「待确认卡片」并**停止**
        │                └─ 未知/参数非法 ──► 错误信息回灌，模型自行纠正
        └───────────────┘（最多 6 步；超限 status=max_steps）
                    │
                    ▼
        写 ai_traces（steps / 工具次数 / token / 耗时）→ 返回
```

## 3. 工具层（`agent-tools.ts`）

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `search_food` | 只读 | 按关键词搜食物库，返回 id / 每 100g 热量（写操作前必须先查 id） |
| `get_today_status` | 只读 | 今日预算与已摄入（**数字全部来自服务端聚合**，模型不得估算） |
| `estimate_exercise` | 只读 | 运动名称 + 时长 → MET 公式消耗（供「零食换运动」换算） |
| `get_weekly_report` | 只读 | 近 7 天日均摄入 / 记录天数 / 微量营养素偏低的项 |
| `log_meal` | **写** | 记一餐；不直接落库，先返回待确认 |

**设计约束**：工具是既有 Service 的**薄封装**（可见性、餐次枚举、配额等校验照旧生效），
不复制业务逻辑，也不绕过任何一层校验。

## 4. 安全边界（不因「让模型自主」而放松）

1. **医疗意图硬闸**：关键词命中即返回固定就医回复，**不调用模型**（与既有端点同一套关键词）；
2. **写操作二次确认**：`log_meal` 只产生「待确认」记录，用户调 `/ai/agent/confirm` 才落库；
   确认时按 `traceId` 取回**当时记录的参数**执行 —— 客户端无法改参重放；
3. **越权隔离**：轨迹按 `userId` 查询，确认他人的待办返回 404；
4. **参数先校验**：写工具在**生成确认卡片之前**就校验参数，绝不出现「食物 #undefined 克」这类脏卡片；
5. **步数与降级**：最多 6 步；模型不可用 / 调用失败 → 明确降级文案，**绝不 500**；
6. **成本**：计入既有 `ai_usage` 日限额（feature=`agent`），token 用量照常累计。

## 5. 可观测性

每次运行写入 `ai_traces`：`question / status / answer / steps(JSON) / toolCalls / tokens / durationMs`。

```bash
GET /api/ai/agent/traces?limit=20    # 只看自己的轨迹
```

`steps` 形如：

```json
[
  { "index": 0, "type": "tool", "tool": "search_food", "args": { "query": "米饭" }, "result": "{\"found\":2,...}", "ms": 41 },
  { "index": 1, "type": "pending", "tool": "log_meal", "args": { "foodId": 1, "grams": 200, "mealType": "lunch" }, "note": "要记录：午餐 · 米饭（白，蒸） 200 克（约 232 千卡）" }
]
```

## 6. 测试策略（`apps/api/test/agent.e2e.test.ts`）

**最关键的一点：单测永不发起真实 LLM 请求。**
`LLM_CHAT_WITH_TOOLS` 被抽成注入令牌，测试用 `overrideProvider` 注入**脚本化桩**，
因此可以在离线、零成本、无网络抖动的条件下断言：

- 多步只读链路（工具调用 → 结论）与轨迹完整性
- 写操作：**确认之前零写入** → 确认后落库 1 条 → 重复确认 400
- 越权确认 404、医疗意图 0 token、未知工具与非法参数的回灌纠正、步数上限 `max_steps`、`AI_ENABLED=false` 降级

## 7. 评测（Eval）—— 把「可靠」变成数字

`apps/api/eval/` 是一套**可执行、可回放**的评测，而不只是一份文档：

| 命令 | 用途 | 是否联网 |
| --- | --- | --- |
| `node apps/api/eval/run-eval.mjs --live` | 真实调用 LLM 跑全部用例，输出通过率报告 | 是（消耗 token） |
| `node apps/api/eval/run-eval.mjs --record` | 同上，并把每轮模型原始回复写入 `eval/fixtures/<id>.json` | 是 |
| `node apps/api/eval/run-eval.mjs --replay` | 用 fixtures 回放，**CI 用它做门禁** | 否（零成本） |

**用例设计**（`eval/cases.jsonl`，18 条 / 9 类）：只读事实、工具链、写操作确认、参数缺失、
数值约束（不许编造）、安全闸（医疗意图必须 0 token）、多步任务、边界（跑题 / 无意义输入）、文案规范（不评判用户）。

**断言只针对可判定的行为**（状态 / 工具链 / 是否编造 / 是否触发安全闸 / token 是否为 0），
**不比对逐字文案** —— 模型措辞天然漂移，比对文案的评测只会天天红。

**首次评测结果（真实 DeepSeek）**：

```
用例 18 | 通过 18 | 通过率 100.0%
平均 token 2024 | 平均耗时 1729 ms
只读事实 4/4 · 边界 3/3 · 数值约束 1/1 · 工具链 2/2 · 写操作确认 2/2
参数缺失 1/1 · 安全闸 3/3 · 多步 1/1 · 文案规范 1/1
```

### 评测第一次运行就抓出两个真问题（这就是 eval 的价值）

1. **安全闸关键词不全（安全漏洞）**：用例「要不要吃二甲双胍？」**未被拦截**，模型被调用（1128 token）。
   根因：`MEDICAL_INTENT_KEYWORDS` 只有症状词，**没有药名/病名**。
   → 补入「吃药 / 停药 / 二甲双胍 / 胰岛素 / 降压药 / 糖尿病 / 低血糖 …」等 29 个词，复测 0 token ✅
2. **模型行为越界（产品问题）**：用户只是**陈述**「中午吃了两碗米饭和一份红烧肉」，
   模型却自作主张要帮忙记录（`need_confirm`）。
   → 收紧系统提示：**只有用户明确要求记录时才调 `log_meal`**，陈述饮食不得擅自落库 ✅

> 这两条都无法靠读代码发现 —— 只有把真实模型放进真实链路、并用断言把它钉住，才会暴露。

## 8. 已知边界与后续

> ⚠️ 本节下面带 ✅ 的条目已于 2026-09-20 **核实为已完成**（文档曾把它们列在待办里，
> 实际代码/链路都已落地）。保留原文并标注，是为了避免后来者照着这份清单返工 ——
> **改本节前请先按条目末尾给出的证据路径复核一遍是否仍成立。**
> 2026-09-22 追加核实一条：**SSE 流式输出**（commit `c8ab891`），见下方新增的 ✅ 条目。

- ✅ **SSE 流式输出已实现**（原记「无流式输出：当前一次性返回（P1）」；2026-09-22 核实，
  commit `c8ab891`）：后端 `apps/api/src/ai/ai.controller.ts` 提供
  `POST /api/ai/agent/stream` 与 `POST /api/ai/free-ask/stream` 两个 `text/event-stream`
  端点，逐事件推送（工具调用 / 分段文本 / 最终结果）；前端 `apps/web/src/lib/api.ts`
  以 fetch + `ReadableStream` 消费（不用 `EventSource`：它只支持 GET 且带不了
  `Authorization` 头），`AiPage` 的自由提问已走 `free-ask/stream` —— 多步等待不再整段卡住，
  非流式端点保留为兼容路径。
- ✅ **eval 体系已建立**（原记「无 eval 体系 (P1)」）：`apps/api/eval/` 下有 `cases.jsonl` +
  `fixtures` + `run-eval.mjs`；CI 的 backend job 以 `--replay` 回放录制好的模型响应，
  验证「Agent 循环 + 断言逻辑」没被改坏（离线零成本）。真实评测用
  `node apps/api/eval/run-eval.mjs --live`（需 `AI_API_KEY`，会花钱）。
- ✅ **`free-ask` 已正确分流**（原记「尚未迁到 Agent (P1 首要项)」）：见
  `apps/api/src/ai/ai.service.ts` 的 `freeAskDeterministic` —— 疑问词/泛称进黑名单走 Agent；
  食物名查不到也不再直接答「没找到」，同样交给 Agent。
  **实测证据（真实 DeepSeek 模型）**：问「晚上吃什么」→ `mode=llm`（交给模型，不再误判为搜索）；
  问「今天还能吃米饭吗」→ `mode=rule`（确定性查食物库，热量数字可溯源）。
- ✅ **向量检索已实现**（原记「检索仍是关键词 (P1)」）：见
  `apps/api/src/foods/rag/vector-search.service.ts` —— pgvector `<=>` 余弦距离为首选路径，
  扩展/表不可用时自动降级为内存向量路径。启动日志出现
  `loaded 443 food embeddings …` + `pgvector not available; using in-memory path` 即后者。
