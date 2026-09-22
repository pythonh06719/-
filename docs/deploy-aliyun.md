# 阿里云部署（轻量应用服务器 + Docker Compose）

> 适用场景：要把「轻生活」挂到公网给评委/老师/同学访问，且**国内访问要快、不想挂代理**。
> 仓库已自带完整容器化（`docker-compose.yml` = nginx(web) + api），本方案**零代码改造**。

## 为什么选阿里云轻量应用服务器

| 对比项 | 阿里云轻量（推荐） | Render 免费档 |
|---|---|---|
| 国内访问 | **快**（华南地域，直连） | 慢/不稳，常需代理 |
| 费用 | 约 ¥24–40/月（常年有 ¥99/年 新用户或学生套餐） | 免费 |
| 备案 | **用 IP + 非 80 端口 → 不需要** | 不涉及 |
| 冷启动 | 无（常驻进程） | 免费档会休眠，首次访问等数秒 |
| 数据 | SQLite 落 docker volume，**删容器不丢** | 免费 PG 有配额/闲置暂停 |

> 想用域名 + 80/443 才需要 ICP 备案（域名实名 + 备案约 1–3 周）。
> **只想尽快给人看 → 用 IP + 8080 端口，跳过备案。**

---

## 一、买服务器

1. 打开 <https://www.aliyun.com/product/swas>（轻量应用服务器）
2. **地域**：华南（深圳/广州）—— 离肇庆最近；华东次之
3. **镜像**：应用镜像 → **Docker**（预装 Docker，省一步；否则选「系统镜像 → Ubuntu 22.04」再自己装）
4. **规格**：**2 核 2G** 起（够用；2C4G 更宽裕，构建更快）
5. **时长**：先买 1 个月试用
6. 学生可先查「阿里云高校计划 / 飞天加速计划」，常有免费或极低价额度

## 二、开放端口（控制台 GUI）

实例 → **防火墙** → 添加规则：

| 应用类型 | 协议 | 端口 | 说明 |
|---|---|---|---|
| 自定义 | TCP | **8080** | 对外访问入口（未备案就用它，别用 80） |
| SSH | TCP | 22 | 一般默认已开 |

## 三、连上服务器

控制台 → 实例 → 右上角 **「远程连接」** → 选 **Workbench**（网页版终端，不用装 SSH 客户端）。

## 四、拉代码 + 起服务（整段复制粘贴）

```bash
# 1) 确认 git 与 docker 就绪
git --version || (apt update && apt install -y git)
docker compose version || docker --version

# 2) 拉代码
cd /opt && git clone https://github.com/pythonh06719/-.git qingshenghuo && cd qingshenghuo

# 3) 写 .env（JWT_SECRET 必填；AI key 建议填，否则 AI 走规则兜底）
#    先生成一段随机密钥：openssl rand -hex 32
cat > .env <<'EOF'
JWT_SECRET=把上面生成的随机字符串粘到这里
AUTH_LOG_CODE=true
AI_ENABLED=true
AI_API_KEY=你的模型key
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat
EOF

# 4) 起服务（对外 8080）
WEB_PORT=8080 docker compose up -d --build
```

首次构建约 **5–15 分钟**（下载 node:22 / nginx 镜像 + `npm ci`）。
`api` 容器启动时会自动执行 `prisma db push` → `seed`（灌食物库）→ 启动服务。

## 五、验证

```bash
docker compose ps                                   # web / api 两个都应是 Up
curl -s localhost:8080/api/health                   # 期望 {"data":{"status":"ok",...},"error":null}
docker compose logs --tail=30 api                   # 看启动日志（含 443 条食物向量加载）
```

浏览器打开：`http://<你的公网IP>:8080/`

## 六、日常操作

```bash
docker compose logs -f api        # 跟踪后端日志
docker compose restart api        # 重启后端
docker compose down               # 停掉
docker compose up -d --build      # 改完代码重建

# 更新到最新代码
git pull && WEB_PORT=8080 docker compose up -d --build
```

**取登录验证码**（`AUTH_LOG_CODE=true` 时，验证码打在日志里）：

```bash
docker compose logs api | grep 验证码 | tail -3
```

> **自 `c856daa`（2026-09-22）起更省事**：开关开启后，`POST /api/auth/send-code` 的响应体会
> **直接带上 6 位验证码**，前端登录卡片会**自动预填** —— 演示时点「获取验证码」后
> 直接点「登录」即可，不必再来日志里抄码。上面的日志取码方式**照旧可用**（原行为不变）。
>
> ⚠️ **安全边界**：这个开关等价于「**知道邮箱即可登录任意账号**」—— 只适合自用 / 演示环境；
> 对外提供真实多用户服务时**绝不可开启**（届时应接入真实邮件发送，见下方安全提醒）。

## 七、常见问题

| 症状 | 排查 |
|---|---|
| 页面打不开 | ① 防火墙是否放行 8080 ② `docker compose ps` 是否 Up ③ 地址是否带 `:8080` |
| 登录收不到码 | 确认 `.env` 里 `AUTH_LOG_CODE=true`；开着时验证码会**随接口响应回显**、由前端登录卡片自动预填（见「取登录验证码」一节），也可用日志取码兜底 |
| AI 不回答 | `docker compose logs api \| grep -i "ai_"`；确认 `AI_API_KEY` 已填 |
| 构建时 OOM 中断（2G 内存） | 加交换分区：`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile` |
| 想用域名访问 | 域名实名 + **ICP 备案**（1–3 周），备案后把 `WEB_PORT=80` 并解析 A 记录 |
| 端口被占用 | 换一个宿主机端口：`WEB_PORT=8090 docker compose up -d` |

## 八、数据持久化

- **SQLite**（默认）：落在 docker volume `api-data` → `/repo/data/dev.db`。**删容器不丢**，
  `docker compose down` 也不会删卷；只有 `down -v` 会删。
- **想换 PostgreSQL**：取消 `docker-compose.yml` 里 `postgres` 服务的注释，
  并把 api 的 `DATABASE_URL` 改成 `postgresql://qsh:qsh@postgres:5432/qingshenghuo`
  （Prisma 会走 `schema.pg.prisma`）。此时向量检索走 pgvector；SQLite 形态下自动降级为内存向量路径，功能等价。

## 九、安全提醒（公开到公网前）

- `JWT_SECRET` 必须是**随机长字符串**（compose 已强制校验，不设会直接报错）
- `AUTH_LOG_CODE=true` 会把验证码打进日志**并随接口响应回显**（前端自动预填，`c856daa` 起）
  —— 等价于「知道邮箱即可登录任意账号」，**仅适合自用 / 演示**；接 SMTP 后改为 `false`
- 数据库密码若启用 PG，务必改掉 `qsh:qsh` 默认值
- 无需长期在线时，用完可在控制台**关机**（按量计费可省）
