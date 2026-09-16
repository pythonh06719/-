# Cloudflare Pages（前端）部署步骤 —— 公网 Demo 简历项

## 方式 A：Git 集成（推荐，push 自动部署）

1. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
2. 选择本仓库，构建设置：
   - Framework preset: **Vite**
   - Build command: `npm install && npm run build -w @qsh/web`
   - Build output directory: `apps/web/dist`
   - Root directory: （留空，monorepo 根）
   - Node version 环境变量：`NODE_VERSION = 20`
3. 环境变量（生产 + 预览都加）：
   - `VITE_API_BASE_URL = https://qingshenghuo-api.onrender.com/api`
4. 保存 → 首次部署完成后获得 `*.pages.dev` 公网域名。

## 方式 B：CLI 直接上传

```bash
npm run build -w @qsh/web
npx wrangler pages deploy apps/web/dist --project-name qingshenghuo
```

## API 跨域

Render 侧 NestJS 已有 CORS 配置时，把 Pages 域名加入白名单；
否则在 Cloudflare Pages 前用 `_redirects` 反代：

```
# apps/web/public/_redirects
/api/*  https://qingshenghuo-api.onrender.com/api/:splat  200
```

## PostgreSQL 路径（Neon 备选）

1. Neon 免费档建库（Postgres 16，支持 pgvector）
2. `psql $DATABASE_URL -f infra/db/migrations/pg/001_pgvector.sql`
3. `npx prisma db push --schema apps/api/prisma/schema.pg.prisma`
4. 灌种子：`npm run db:seed -w @qsh/api`（配好 DATABASE_URL_PG 后）
5. 同步向量：`node apps/api/scripts/sync-embeddings-pg.mjs`
