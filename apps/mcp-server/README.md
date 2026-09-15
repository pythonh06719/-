# `@qsh/mcp-server` —— 轻生活 MCP Server

把「食物库 + 热量引擎」暴露为 **标准 MCP 工具**（stdio 传输），任何支持 MCP 的客户端
（WorkBuddy / Claude Desktop / Cursor / 其它 agent）都能直接调用。

**零新依赖**：MCP over stdio 本质是换行分隔的 JSON-RPC 2.0，本服务手写协议实现（~150 行），
只依赖既有的 `@qsh/core`（纯函数引擎，公式不复制）与 `@prisma/client`（食物库只读查询）。

## 工具清单（全部只读）

| 工具 | 说明 |
| --- | --- |
| `search_food` | 按名称关键词搜索食物库（443 条中文食物，含每 100g 热量与三大营养素） |
| `calc_budget` | 热量预算（Mifflin-St Jeor → TDEE → 缺口），**内置安全下限与缺口上限**并返回保护是否触发 |
| `estimate_exercise` | MET 公式运动消耗（kcal = MET × 体重 × 时长） |
| `list_activities` | 支持的运动清单（编码 / 名称 / MET） |

**刻意只做只读**：stdio 本地服务没有鉴权层，因此不暴露任何写操作与用户数据。

## 运行

```bash
# 依赖已随仓库 workspace 安装；DATABASE_URL 缺省同 API（apps/api/prisma/dev.db）
DATABASE_URL="file:./apps/api/prisma/dev.db" npm run start -w @qsh/mcp-server
```

## 接入 MCP 客户端示例

```json
{
  "mcpServers": {
    "qingshenghuo": {
      "command": "npx",
      "args": ["tsx", "apps/mcp-server/src/index.ts"],
      "cwd": "<仓库根>",
      "env": { "DATABASE_URL": "file:./apps/api/prisma/dev.db" }
    }
  }
}
```

## 验证

```bash
node apps/mcp-server/test-stdio.mjs
```

完整走一遍协议（initialize → tools/list → 三个 tools/call），全通过输出
`✓ MCP server 验证通过`。

## 实现

`src/index.ts` 手写实现了 stdio 传输所需的 MCP 协议子集：
`initialize` 握手、`tools/list`、`tools/call`、`ping` 与通知处理（换行分隔 JSON-RPC 2.0）。
