# Cloudflare Pages（前端）部署步骤 —— 公网 Demo 简历项

> **关键事实（务必先读）**：前端所有请求都打**同源相对路径 `/api/*`**，代码**不读取任何 `VITE_*` 变量**
> （见 `apps/web/src/lib/api.ts:136`；dev 由 Vite proxy 转发到 `localhost:3000`，生产由反向代理转发）。
> 因此**不要设置 `VITE_API_BASE_URL`** —— 设了也不会被前端使用，照做会让线上所有 API 调用 404。
> 正确的生产转发方式是 Cloudflare Pages 的 `apps/web/public/_redirects`（见下文）。

## 方案 0（**推荐**）：Render 单服务 —— 一个 URL 全含

`main.ts` 在生产模式下由 API 同源伺服前端 SPA（静态文件 + SPA 回退），`render.yaml` 的
buildCommand 也已包含前端构建（`npm run build -w @qsh/web`）→ **部署完 Render 即得完整 Demo**：
无需 Cloudflare、无需 CORS 配置（同源）、无需反向代理。

1. Render Dashboard → New → **Blueprint** → 连接本仓库 → Apply（`render.yaml` 驱动全部构建/建表/同步）
2. 构建日志确认：`SPA 静态伺服已启用：…/apps/web/dist（单 URL 部署模式）`
3. 手动补环境变量：`AI_API_KEY`、`AUTH_LOG_CODE=true`（见检查清单）
4. **单 URL 即完整应用**：`https://qingshenghuo-api.onrender.com`（前端、API 同源）

> 下文的 Cloudflare Pages 部署保留为**备选方案**（前后端分离、CDN）；两者选其一即可。

## 方式 A：Git 集成（推荐，push 自动部署）

1. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
2. 选择本仓库，构建设置：
   - Framework preset: **Vite**
   - Build command: `npm install && npm run build -w @qsh/web`
   - Build output directory: `apps/web/dist`
   - Root directory: （留空，monorepo 根）
   - Node version 环境变量：`NODE_VERSION = 20`
3. 环境变量：**无需设置任何 `VITE_*` 变量**。API 转发由 `_redirects` 完成（见下）。
4. 保存 → 首次部署完成后获得 `*.pages.dev` 公网域名。

## 方式 B：CLI 直接上传

```bash
npm run build -w @qsh/web
npx wrangler pages deploy apps/web/dist --project-name qingshenghuo
```

## API 反向代理（`_redirects`）

前端打同源 `/api/*`，生产由 `apps/web/public/_redirects` 反代到 Render：

```
# apps/web/public/_redirects
/api/*  https://qingshenghuo-api.onrender.com/api/:splat  200
/*      /index.html                                       200
```

- 第 1 行：把 `/api/*` 代理到 Render 后端（`200` = 代理/重写，不是跳转）。
  ⚠️ 域名占位：若 Render 服务名不是 `qingshenghuo-api`，替换为实际地址。
- 第 2 行：SPA 回退（前端路由刷新不 404）。

## API 跨域（CORS）

Render 侧 NestJS 的 CORS 白名单读取环境变量 **`CORS_ORIGINS`**（逗号分隔，
见 `apps/api/src/config/app-config.ts`）。请在 `render.yaml`（或 Render Dashboard）中把
Cloudflare Pages 域名加入，例如：

```
CORS_ORIGINS = https://qingshenghuo.pages.dev,http://localhost:5173
```

> 若前端经上面的 `_redirects` 同源反代 `/api`，浏览器视角是同源请求，CORS 通常不会触发；
> 但仍建议显式配置，以防前端直连后端。

## AI（三期 R9）

在 `render.yaml` 已配置非密项：`AI_ENABLED=true`、`AI_BASE_URL=https://api.deepseek.com/v1`、`AI_MODEL=deepseek-chat`。
**`AI_API_KEY` 必须手动填**：Render Dashboard → 服务 → Environment 新增 `AI_API_KEY`（仓库内绝不放 key）。

> ⚠️ **base url 必须与 key 同源**：仓库默认按 **DeepSeek** 配置。若你手上是 OpenAI 官方 key，
> 请同时把 Render 环境变量里的 `AI_BASE_URL` 改成 `https://api.openai.com/v1`、`AI_MODEL` 改成 `gpt-4o-mini`
> ——否则 key 打到不匹配的网关，AI 必然 401（前端会退回规则兜底文案，不会白屏，但看起来"AI 没生效"）。

未配置时 AI 入口自动降级为服务端规则兜底。

## PostgreSQL 路径（Render Postgres / Neon 备选）

1. 建库（**Postgres 16+**，支持 pgvector）。
2. `npx prisma db push --schema apps/api/prisma/schema.pg.prisma`（建业务表）。
3. 灌种子：`npm run db:seed -w @qsh/api`（配好 `DATABASE_URL_PG` 后）。
4. 同步向量：`node apps/api/scripts/sync-embeddings-pg.mjs`
   - 该脚本会**幂等自动执行** `infra/db/migrations/pg/001_pgvector.sql`
     （建 `vector` 扩展 + `food_embeddings` 表 + 余弦索引），**无需人工先跑 SQL**。
   - 手工执行（**可选**，可重复执行，定义只此一份）：
     `psql $DATABASE_URL_PG -f infra/db/migrations/pg/001_pgvector.sql`

> 在 Render Blueprint 流程中，第 2~4 步已并入 `render.yaml` 的 `buildCommand`，通常无需手动执行。

## ⚠️ 公开 Demo 的登录：必须开 `AUTH_LOG_CODE`（否则谁都登不进）

本项目**尚未接入 SMTP**（`auth.service.ts:46` 注释：开发环境把验证码打到服务端日志，不接真实 SMTP）。
而生产环境**默认不打印**验证码（安全考虑，`AUTH_LOG_CODE` 默认 `false`）——
这意味着：访客在公网 Demo 上点「发送验证码」**收不到任何邮件**，也就无法登录。

**Demo 环境两种解法（二选一）**：

| 方案 | 做法 | 适用 |
| --- | --- | --- |
| **A. 开日志取码（推荐给作品集 Demo）** | Render → 服务 → Environment 新增 `AUTH_LOG_CODE=true` → 保存（自动重新部署）。之后在 Render → **Logs** 里能看到 `[验证码] you@x.com → 123456`，用它登录 | 演示、自测；**绝不要用于真实用户环境**（日志会泄露验证码） |
| B. 接入 SMTP | 自建邮件发送（如 Resend / SendGrid / 腾讯云 SES），把发送逻辑接进 `auth.service.ts`，再关掉 `AUTH_LOG_CODE` | 面向真实用户时 |

> 免登录也能演示的部分：落地页的**免注册热量计算器**（`CalorieCalculator`）不需要账号，
> 适合放给别人先看效果；要演示日记/Agent 问答才需要登录。

## 部署前检查清单

- [ ] **`AUTH_LOG_CODE=true`（Demo 专用）**：不设则访客收不到验证码、无法登录（见上一节；真实用户环境请改用 SMTP）。
- [ ] **Render 手动填 `AI_API_KEY`**：Dashboard → 服务 → Environment 新增 `AI_API_KEY`（仓库内绝不放 key；不填则 AI 走规则兜底）。
- [ ] **CORS 域名**：确认 `render.yaml` 的 `CORS_ORIGINS`（或 Dashboard）已替换为真实 Cloudflare Pages 域名。
- [ ] **⚠️ 回填分享卡片域名（易漏）**：`apps/web/index.html` 里的 `og:url` 与 `og:image` 目前是占位域名
  `https://qingshenghuo-api.onrender.com/`。部署后拿到真实域名，必须把这两处改成真实地址并 push ——
  **og 的图片与链接必须是绝对 URL，爬虫（尤其微信）不解析相对路径**；不改则分享出去仍是占位域名的图，
  表现为「分享卡片有标题但无缩略图」或指向上不存在的图。
- [ ] **向量表自动就绪**：查看 Render 构建日志出现 `已确保 pgvector 扩展与 food_embeddings 表就绪` 与 `synced ... embeddings`；若报 pgvector 相关错误，确认数据库为 Postgres 16+。
- [ ] **健康检查**：`curl -s https://<你的-api-域名>/api/health` 返回 200，且响应形如 `{"data":{"status":"ok",...},"error":null}`。
- [ ] **端到端 AI 验证**：在前端跑一次 AI 问答，返回应为**模型生成**的答案（而非固定规则兜底文案），说明 `AI_API_KEY` 生效。
- [ ] **免费档注意事项**：Render 免费 Web Service 在一段时间无请求后会休眠（冷启动需数秒）；免费 Postgres 有存储/连接数配额，可能因闲置被暂停，长期 Demo 需留意唤醒与配额。
- [ ] **⚠️ 仅当库是「旧的已建库」时才需注意**：本次把 PG 侧的 8 个 JSON 契约列由 `Json` 改成了 `String`（`TEXT`）。若目标库是**早期用旧 schema 建过**的（这些列已是 `JSONB`），`prisma db push` 会把 `JSONB → TEXT` 视为潜在破坏性变更并要求 `--accept-data-loss`，否则**构建会红**。处理方式二选一：①**全新库**（首次部署）→ 无需任何操作；②已建库 → 先手工 `ALTER TABLE … ALTER COLUMN … TYPE text USING …::text`，或临时在 buildCommand 的 `db push` 后加 `--accept-data-loss`（**仅在确认无重要数据时**，之后记得移除该 flag）。
