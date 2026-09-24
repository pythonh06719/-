# 轻生活 · 微信小程序（真机体验版）部署说明

本项目是把「轻生活」Web 应用移植成的**微信小程序**（Taro + React），用于个人自用。
当前为 **MVP 核心循环**：登录/注册 → 完善资料 → 今日看板 → 记饮食 → 记体重（含趋势图）。

---

## 1. 工程与复用关系

```
qingshenghuo
├── packages/core        # 热量/运动计算引擎（纯函数，小程序直接复用，零改动）
├── packages/shared-types# 前后端契约类型（小程序直接复用，零改动）
├── apps/api            # 后端 NestJS（保持不变，小程序直接调它的 HTTPS 接口）
├── apps/web            # 原有 Web 端（保持不变）
└── apps/miniprogram    # ← 本次新增的小程序工程（Taro）
    ├── src/lib/api.ts        # 用 Taro.request 替代 fetch，绝对 HTTPS base + Bearer
    ├── src/store/auth.store.ts # 登录态存 wx 本地存储（替代 sessionStorage）
    ├── src/pages/*           # 5 个页面
    └── config/index.ts       # 已配置让 Taro 一并转译 packages/core、packages/shared-types
```

后端**完全不用动**：它本来就是 JWT 鉴权的无状态 REST，小程序用 `wx.request`
（Taro 封装为 `Taro.request`）直接打 `https://qinglife.app.workbuddy.host/api` 即可，
CORS 不约束小程序。

---

## 2. 本地用微信开发者工具预览

1. 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)。
2. 进入 `qingshenghuo/apps/miniprogram` 目录，构建小程序产物：
   ```bash
   npm run build:weapp        # 会生成 dist/ 目录（微信小程序源码）
   # 或边改边看：npm run dev:weapp
   ```
3. 开发者工具 → 导入项目 → 目录选 `qingshenghuo/apps/miniprogram/dist`。
4. AppID 选「测试号」（或填你自己的）。
5. 勾选 **详情 → 本地设置 → 不校验合法域名**（开发阶段必须，否则请求发不出去）。
6. 编译即可在模拟器看到界面；点「预览」用手机扫码也能在真机上看（仍需不校验域名）。

> 注意：`dist/` 是小程序的**构建产物**，真正的源码在 `src/`。改代码后重新 `build:weapp` 再刷新。

---

## 3. 真机体验版（给自己手机长期用）

开发者工具的「预览」扫码只能临时看，且依赖电脑在线。要让手机独立用，走**体验版**：

1. **注册微信小程序账号**：微信公众平台 mp.weixin.qq.com → 注册「小程序」→ 个人主体即可（免费）。
   记下你的 **AppID**。
2. 把 `apps/miniprogram/project.config.json` 里的
   `"appid": "touristappid"` 改成你的真实 AppID。
3. 重新 `npm run build:weapp`，用开发者工具导入 `dist/`，点 **上传**（填版本号如 1.0.0）。
4. 公众平台 → 管理 → 版本管理 → 把刚上传的**开发版**设为 **体验版**。
5. 公众平台 → 成员管理 → 添加你自己的微信为**体验者**（扫码确认）。
6. 你的微信里会收到「小程序体验版」入口，点开即用，不依赖电脑。

### 合法域名（关键，否则真机请求失败）

真机体验版**不认**「不校验合法域名」这个开关，必须在后台登记：

> 公众平台 → 开发 → 开发管理 → 开发设置 → **服务器域名 → request 合法域名**
> 添加：`https://qinglife.app.workbuddy.host`

⚠️ 微信要求 request 域名**必须已 ICP 备案**。当前 `qinglife.app.workbuddy.host`
所属域名若未备案，会加不进去——这种情况请改为指向**你自己备案过的后端域名**（见第 5 节），
改 `apps/miniprogram/src/config.ts` 里的 `API_BASE_URL` 即可。

---

## 4. 登录验证码怎么拿

小程序登录走「邮箱 + 验证码」，服务端 `send-code` 会把验证码发到邮箱。
但当前云端沙箱**未必配置了邮件发送**。两种办法：

- **办法 A（推荐，长期）**：你自己部署一份后端（`apps/api`），在环境变量里
  设 `AUTH_LOG_CODE=true`，验证码会直接回显在 `send-code` 的响应里（小程序登录页会自动
  帮你填好并显示），不需要邮件。详见仓库根目录的部署文档 / `docs/deploy-aliyun.md`。
- **办法 B（临时）**：先用已上线的 Web 端（https://qinglife.app.workbuddy.host/）
  用同一邮箱注册拿验证码，再在小程序里用同一邮箱登录（token 是邮箱维度，通用）。

---

## 5. 数据持久化提醒（很重要）

云端沙箱的数据库是 **SQLite 文件，重新发布 / 容器重建后数据会被清空**。
所以：现在适合**试用和随手记**，但别把它当唯一长期存档。

要长期保存（真正常用），二选一：

1. **换持久化后端**：把 `apps/api` 部署到你自己的服务器 / 已备案域名，并使用持久化数据库
   （Postgres / Supabase / CloudBase 等）。官方已预留 `schema.pg.prisma` 与 `DATABASE_URL_PG`
   生产路径，填好连接串即可。
2. **保持沙箱**：每次重新发布后重新登录即可，历史数据会丢——仅建议体验用。

---

## 6. 常见命令

```bash
cd apps/miniprogram
npm run build:weapp     # 构建微信小程序产物到 dist/
npm run dev:weapp       # 监听改动并增量构建（配合开发者工具刷新）
```

修改后端地址：`src/config.ts` 的 `API_BASE_URL`。
样式为暗色工业风，令牌集中在 `src/theme.ts`，通用类在 `src/styles/global.scss`。
