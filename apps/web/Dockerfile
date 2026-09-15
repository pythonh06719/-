# 「轻生活」Web 镜像：Vite 构建产物由 nginx 托管（含 PWA），/api 反代到后端
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm ci --registry=https://registry.npmmirror.com
RUN npm run build -w @qsh/web

FROM nginx:1.27-alpine
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
# 容器加固：健康检查（busybox 的 localhost 会解析到 ::1，而 nginx 只监听 IPv4 → 必须用 127.0.0.1）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
EXPOSE 80
