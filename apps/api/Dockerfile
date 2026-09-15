# 「轻生活」API 镜像：多阶段构建，产物自包含（别名已改写为相对路径）
#
# 关键点（部署验证中修复）：
# - 构建阶段必须跑 `prisma generate`，否则容器内没有 Prisma 客户端类型（TS7006）且运行期必崩
# - 运行阶段镜像内保持仓库布局（node_modules / packages / apps / infra / package.json）：
#   prisma seed 脚本按仓库根解析 `infra/db/seed/*.json`，保持布局才能一条命令灌种子
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY infra ./infra
RUN apk add --no-cache openssl libc6-compat
RUN npm ci --registry=https://registry.npmmirror.com
RUN npx prisma generate --schema apps/api/prisma/schema.prisma
RUN npm run build -w @qsh/api

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps ./apps
COPY --from=build /repo/infra ./infra
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/tsconfig.base.json ./tsconfig.base.json
# 运行期依赖（部署验证中修复）：
# - Prisma 在 alpine 上需要 openssl 才能正确探测 libssl 版本
# - 容器以 node 用户运行，Prisma 运行期要写引擎目录 → 精准授权（避免全量 chown 的开销）
RUN apk add --no-cache openssl libc6-compat \
 && mkdir -p /repo/data \
 && chown -R node:node /repo/data /repo/node_modules/@prisma /repo/node_modules/.prisma /repo/node_modules/.bin 2>/dev/null || true
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1
EXPOSE 3000
CMD ["node", "apps/api/dist/apps/api/src/main.js"]
