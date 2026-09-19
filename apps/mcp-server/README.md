# `@qsh/mcp-server` —— 轻生活 MCP Server

把「食物库 + 热量引擎 + 记录能力」暴露为 **标准 MCP 工具**（stdio 传输），任何支持 MCP 的客户端
（WorkBuddy / Claude Desktop / Cursor / 其它 agent）都能直接调用。

**零新依赖**：MCP over stdio 本质是换行分隔的 JSON-RPC 2.0，本服务手写协议实现（~500 行），
只依赖既有的 `@qsh/core`（纯函数引擎，公式不复制）与 `@prisma/client`（食物库 / 记录读写）。

## 工具清单（11 个）

标 **只读** 的工具不改变任何数据；标 **写** 的工具会落库，且**需要** `MCP_USER_ID`。
标 ✓ 的只读工具读取**本机当前用户**的数据，同样需要 `MCP_USER_ID`（无用户可读）。

| 工具 | 读写 | 需 `MCP_USER_ID` | 说明 |
| --- | --- | --- | --- |
| `search_food` | 只读 | — | 按名称关键词搜索食物库（443 条中文食物，含每 100g 热量与三大营养素） |
| `calc_budget` | 只读 | — | 热量预算（Mifflin-St Jeor → TDEE → 缺口），**内置安全下限与缺口上限**并返回保护是否触发 |
| `estimate_exercise` | 只读 | — | MET 公式运动消耗（kcal = MET × 体重 × 时长） |
| `list_activities` | 只读 | — | 支持的运动清单（编码 / 名称 / MET） |
| `explain_budget` | 只读 | — | 热量预算的**推导明细**（BMR 公式 → 活动系数 → TDEE → 原始缺口 → 缺口上限 → 有效缺口 → 安全下限 → 建议摄入） |
| `get_daily_summary` | 只读 | ✓ | 某日汇总（摄入 / 剩余 / 饮水 / 运动 / 预算），默认今天 |
| `list_recent_meals` | 只读 | ✓ | 最近 N 天饮食记录（默认 3 天，最多 30 天） |
| `get_weight_trend` | 只读 | ✓ | 体重趋势（默认 30 天，最多 365 天）+ 最新值 / 区间变化 / 最小最大 |
| `log_meal` | **写** | ✓ | 记录一餐（`foodId` 必须来自 `search_food`，写入前校验食物存在且可见） |
| `log_water` | **写** | ✓ | 记录饮水（默认 250ml） |
| `log_weight` | **写** | ✓ | 记录体重（同一天重复记录会覆盖当日值） |

## 写操作的安全设计（重要）

stdio 本地服务**没有鉴权层**，因此写操作必须显式授权：

- 新增环境变量 **`MCP_USER_ID`**（正整数）指定**本机唯一用户**；
- **写工具不接受 `userId` 参数** —— 避免调用方任意指定他人账号（越权防线）；
- **未配置 `MCP_USER_ID` 时，写工具直接返回可读错误**（`写操作已禁用：请设置 MCP_USER_ID 后再启用`），
  **不执行任何写入** —— 即默认关闭写入，需显式开启；
- 读取用户数据工具（`get_daily_summary` 等）同样只认 `MCP_USER_ID`；未配置时给出可读错误；
- 入参严格校验：`grams` 1~5000、`mealType ∈ {breakfast,lunch,dinner,snack}`、`minutes` 1~600、
  体重 1~500、饮水量 50~2000ml；**非法值返回可读错误，不静默转换**；
- `log_meal` 写入前必须校验 `foodId` 存在（查 `food_items`），不存在则报错。

> 定位：**本地单用户工具**。一台机器上一个 `MCP_USER_ID`；如需多用户，请自行在外部加一层鉴权后按用户启动多实例。

## 运行

```bash
# 依赖已随仓库 workspace 安装；DATABASE_URL 缺省同 API（apps/api/prisma/dev.db）
DATABASE_URL="file:./apps/api/prisma/dev.db" MCP_USER_ID=1 npm run start -w @qsh/mcp-server
```

## 接入 MCP 客户端示例

```json
{
  "mcpServers": {
    "qingshenghuo": {
      "command": "npx",
      "args": ["tsx", "apps/mcp-server/src/index.ts"],
      "cwd": "<仓库根>",
      "env": { "DATABASE_URL": "file:./apps/api/prisma/dev.db", "MCP_USER_ID": "1" }
    }
  }
}
```

> 不设置 `MCP_USER_ID` 时，只读工具（`search_food` / `calc_budget` / `estimate_exercise` /
> `list_activities` / `explain_budget`）照常可用，写工具与用户数据读取工具会返回可读错误。

## 验证

```bash
node apps/mcp-server/test-stdio.mjs
```

脚本走完整协议并断言：

1. `tools/list` 返回 **11** 个工具；
2. `explain_budget`（无需用户配置）返回 **9 步推导**；
3. **授权闸**：未设 `MCP_USER_ID` 时，`log_meal` / `log_water` / `log_weight` / `get_daily_summary`
   均返回包含「MCP_USER_ID」的可读错误；
4. 设测试用 `MCP_USER_ID` 后：`get_daily_summary` / `list_recent_meals` 真实取数成功，
   `log_water` 走通成功路径（写入后自动清理），对不存在的 `foodId` 调用 `log_meal` 返回可读错误。

全通过输出 `✓ MCP server 验证通过`。

## 实现

`src/index.ts` 手写实现了 stdio 传输所需的 MCP 协议子集：
`initialize` 握手、`tools/list`、`tools/call`、`ping` 与通知处理（换行分隔 JSON-RPC 2.0）。
