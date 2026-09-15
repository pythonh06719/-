# T05 三期（AI 功能）独立验证报告

- 验证人：software-qa-engineer-3（Edward，QA Engineer）
- 日期：2026-09-12
- 性质：**独立验证**，不采信工程师自述，三套件与本报告全部用例均为实跑结果
- 环境：Windows / Node 22.22.2 / SQLite dev.db；`AI_API_KEY=""`（双模式之规则兜底路径）

---

## 1. 结论摘要

**总体判定：通过（附 3 项 P2 遗留，无 P0 / P1）。**

| 分档 | 数量 | 说明 |
| --- | --- | --- |
| P0 | 0 | 三条安全红线（R9.5 / R9.6 / R9.4）全部实测通过 |
| P1 | 0 | — |
| P2 | 3 | 见 §7 遗留问题清单 |

- 三套件回归：core **84/84**、api **22/22**（14+8 新增 AI 用例）、web **51/51**（38+13 新增 reminder/share-card 用例）；web `tsc --noEmit` 0 错误；`npm run build -w @qsh/web` 构建成功（含 sw.js PWA 产物）。
- R9.5（key 仅服务端）：前端 src + dist（含 sw.js / workbox 产物）grep **0 命中**；key 只从服务端环境变量读取、只在服务端发出的 Authorization 头出现。
- R9.6（就医兜底）：7 组医疗意图实测，6 组正确触发；`心情低落` 未命中（P2 关键词覆盖缺口，输出本身仍安全）。
- R9.4（限额）：free_ask 第 50 次成功、第 51 次 **429 E_LIMIT_AI**；四 feature 行 SUM 判定实测通过；医疗兜底不计数；today-plan 缓存不计数；每账号独立。
- 二期抽查：`/api/water`、`/api/exercises`、`/api/report/weekly`、`DELETE /data` 功能本身未被三期破坏（`DELETE /data` 后持旧 JWT 的请求返回 500 属二期遗留边界缺陷，见 BUG-P3-3）。
- 智能路由判定：**Engineer**（2 项三期 P2 修复建议 + 1 项二期遗留 P2 记录）。

---

## 2. 三套件回归（自实跑）

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| core | `npx vitest run --root packages/core` | **7 文件 84/84 通过**（837ms），与二期一致，未被改动 |
| api | `npx vitest run --root apps/api` | **2 文件 22/22 通过**（api.e2e 14 + ai.e2e 8），与自述 +8 一致 |
| web | `npx vitest run --root apps/web` | **9 文件 51/51 通过**（含 reminder 11、share-card 2 新用例），与自述 +13 一致 |
| web 类型 | `tsc --noEmit` | 退出码 0 |
| web 构建 | `npm run build -w @qsh/web` | 成功，precache 6 entries，产物含 `dist/sw.js`、`workbox-*.js` |

**shared-types 纯增量核查**：`packages/shared-types/src/index.ts` 既有 5 个 `export *`（entities/api/ai/export + 具名导出）全部保留，新增 `src/ai.ts` 与 entities 中的 `AiFeature`/`AiUsage` 契约；三套件 + tsc 全绿即证明既有导出未破坏。✅

---

## 3. ★ 安全红线一：R9.5 key 仅服务端

### 3.1 前端产物泄漏扫描（独立复核，含 sourcemap 与 service worker）

```
grep -riln "AI_API_KEY|AI_BASE_URL|api.openai|dashscope|anthropic|openai|Bearer " apps/web/dist/ apps/web/src/
→ 2 个文件命中，逐一人工核对：
  1) apps/web/src/lib/api.ts —— 仅 "Bearer "（前端给 /api 请求附带自身 JWT，非 AI 凭据）
  2) apps/web/dist/assets/index-BEHghwbg.js —— 同上（api.ts 的编译产物，Authorization=`Bearer ${JWT}`，仅用于 /api 域内请求）
AI_API_KEY / AI_BASE_URL / openai / dashscope / anthropic：0 命中（dist 含 sw.js、workbox-0ec0a0c2.js 全量扫描；dist 无 .map sourcemap 文件）
```

**结论：0 泄漏 ✅**

### 3.2 服务端读取路径（代码级确认）

- `apps/api/src/config/app-config.ts` L110-112：`apiKey: readEnv('AI_API_KEY','')` 等三项均读服务端环境变量；`apps/api/.env` 中 `AI_API_KEY=""`（本环境未配置 → 走规则兜底）。
- `apps/api/src/ai/llm.client.ts`：key 仅用于 L86 `Authorization: Bearer ${config.apiKey}`（服务端 → LLM 提供方的请求头）；L99-101 失败时只记录状态码 `ai_llm_request_failed_status_${status}`，**不记录请求体/响应体**；`AiRuntimeConfig` 不进入任何响应 DTO。
- 运行期复核：本机实测所有 AI 响应体均无任何 key/baseUrl/model 字段（响应仅 `available/reason/mode/insight/...`）。

### 3.3 前端直连与 CSP 兼容性

- `apps/web/src/lib/api.ts` L136：唯一 fetch 出口 `fetch(buildUrl(`/api${path}`, query))` —— 前端**只打 `/api/*` 同域路径**，无任何 AI 域名直连。
- `infra/nginx/default.conf` L11：`connect-src 'self'` —— 与实现**兼容** ✅。

---

## 4. ★ 安全红线二：R9.6 就医兜底

### 4.1 医疗意图实测（用户 A，key 未配置，7 组）

原始响应片段（6 组命中的回复均为同一固定文案）：

```json
{"date":"2026-09-12","question":"我最近总是头晕",
 "answer":"谢谢你愿意说起这些。这件事涉及身体状况和用药，我们不做疾病诊断，也不建议自行停药或者突然大幅改变饮食。如果你现在不太舒服，建议咨询医生或当地的专业机构（比如社区卫生服务中心），他们会给你更稳妥的帮助。这段时间先照顾好自己，规律地吃好每一餐，我们一直都在。",
 "available":false,"mode":"rule","safetyFlag":true,"matchedFood":null}
```

| # | 输入 | safetyFlag | 结论 |
| --- | --- | --- | --- |
| 1 | 我最近总是**头晕** | true ✅ | 固定就医回复 |
| 2 | 我想把降糖药**停药**了行不行 | true ✅ | 固定就医回复 |
| 3 | **怀孕**了还能继续减重吗 | true ✅ | 固定就医回复 |
| 4 | 最近总是控制不住**暴食** | true ✅ | 固定就医回复 |
| 5 | 吃多了好想**催吐** | true ✅ | 固定就医回复 |
| 6 | 我今天跑了五公里但是有点**头晕**（长句藏匿） | true ✅ | 固定就医回复 |
| 7 | **心情低落**不想吃饭 | **false ❌** | 未命中（见 BUG-P3-1）；返回"暂不可用"引导文案，输出本身无医疗风险内容 |

### 4.2 不调用 LLM + 不消耗限额

- **代码级**：`ai.service.ts` L174-184，`matchMedicalIntent(question)` 命中即 return，位于 `consumeQuota`（L186）与 `tryChat`（L206+）**之前**，物理上不可能触达 LLM 与限额。
- **运行级**：医疗测试前 `ai_usage` 为空 `[]`，7 组请求后仅余 `('free_ask', 1)` —— 该 1 次即第 7 组"心情低落"未命中闸门所致；**6 组真实医疗请求消耗为 0** ✅。
- 交叉验证：限额用尽后（用户 B 已 50/50）医疗问题仍返回 **200 + safetyFlag:true**（兜底不受限额影响，符合安全优先设计）✅。

### 4.3 固定回复文案禁词 grep

禁词表：`会死 / 危险 / 警告 / 必须马上 / 后果自负 / 活该 / 完蛋` → 全部 0 命中；文案含"建议咨询医生/专业机构"，无恐吓、无诊断式表达（明确写"我们不做疾病诊断"）✅。

### 4.4 交叉验证（正常问题）

```
POST /ai/free-ask {"question":"我今天还能吃奶茶吗"}
→ {"answer":"珍珠奶茶每 100g 约 90 kcal。今天已摄入的已经超过参考摄入了…","safetyFlag":false,"matchedFood":{"foodId":26,"name":"珍珠奶茶","kcalPer100g":90,...}}
```

正常问题走食物库确定性回答路径，`safetyFlag:false` ✅。

---

## 5. ★ 安全红线三：R9.4 限额（对抗性实测）

### 5.1 单 feature 计数（用户 B，free_ask）

手数过程：B 先发 1 次基线（"我今天还能吃奶茶吗"，成功）→ 循环连发 49 次成功 → **累计 50 次全部 200** → 第 51 次：

```json
{"data":null,"error":{"code":"E_LIMIT_AI","message":"今天的 AI 次数已经用完啦，明天再来聊聊就好"}}
```

HTTP 状态 **429**，`ai_usage` 表核对：`[('free_ask', 50)]` ✅（响应保持 `{data,error}` 包装 ✅）。

### 5.2 SUM 判定（用户 A，四 feature 行合计）

A 预消耗（E 项功能测试产生）：`daily_summary=2, today_plan=2, free_ask=3, food_recognize=1`（合计 8）。
按补齐 `free_ask→25`、`food_recognize→20` 填充后 `SUM=49`，再发 1 次 free_ask 成功（`SUM=50`），此后：

| 请求 | 结果 |
| --- | --- |
| `POST /ai/free-ask` | **429 E_LIMIT_AI** ✅ |
| `POST /ai/recognize-food` | **429 E_LIMIT_AI** ✅（跨 feature SUM 拦截） |
| `POST /ai/daily-summary` | **429 E_LIMIT_AI** ✅（跨 feature SUM 拦截） |

`ai_usage` 终态：`[('daily_summary',2),('food_recognize',20),('free_ask',25),('today_plan',2)]`，SUM=50，与拦截行为一致 ✅。**四个 feature 行合计判定实锤。**

### 5.3 医疗兜底不计入

§4.2 已证：6 组医疗请求前后 `ai_usage` 不变；且限额用尽后医疗兜底仍 200 可用 ✅。

### 5.4 today-plan 缓存不计数

- 调用 #1：`cached:false`，`today_plan=1`；
- 调用 #2（数据未变）：`{"cached":true,...}`，`today_plan` 仍为 **1**（不计数）✅；
- 插入一餐（米饭 150g，`POST /meals` 200）后调用 #3：`cached:false`（哈希变化重新生成），`today_plan=2`（计数）✅。

### 5.5 每账号独立

- A 用满（SUM=50 全 429）后注册全新账号 C：`POST /ai/free-ask` → **200 正常回答** ✅；
- B 用尽自身 50 次后 429，与 A 的状态无关 ✅。

### 5.6 daily-summary 无缓存、逐次计数

2 次调用 → `daily_summary=2`（对照 today-plan 的缓存行为，差异符合设计：daily-summary 本身无缓存）。

---

## 6. 功能与前端明细

### 6.1 降级链路（E-1，key 未配置）

- 4 个端点全部 **200，无 500**：daily-summary / today-plan / free-ask / recognize-food ✅。
- `available:false` 时 daily-summary / today-plan 均带规则三段式 `insight`（conclusion + basis + suggestion）✅。
- **规则内容基于真实数据**：记 1 餐米饭 150g（174 kcal）前，daily-summary 结论为"2026-09-12 还没有记录…"；记餐后变为 `"今天摄入约 174 kcal，记录得很完整"`，basis 含 `"饮食记录合计 174 kcal"`（116 kcal/100g × 150g = 174，手算一致）✅。

### 6.2 recognize-food（E-2）

```
POST /ai/recognize-food {"description":"一碗米饭和一个鸡蛋"}
→ candidates[0] = {"foodId":1,"name":"米饭（白，蒸）","kcalPer100g":116,"matchedText":"米饭",
   "defaultServingGrams":150,"servingUnitLabel":"小碗","servingKcal":174}
   其后候选：黄焖鸡米饭/番茄炒蛋/西红柿蛋汤/蛋卷（均来自 57 条种子食物库）
```

- 候选全部来自食物库，每条含每 100g 热量与份量热量 ✅（注：库中无独立"鸡蛋"条目，分词"鸡蛋"无命中但"米饭"命中，行为符合"候选可与食物库零匹配"契约）。
- **绝不写 meal_logs**：调用前后 `GET /meals` 行数 0 → 0 ✅；确认入库必须走既有 `POST /meals`（前端 AiPage `confirmMutation` 才调 `api.post('/meals', {source:'ai', foodId...})`，"确认记录"按钮触发）✅。

### 6.3 free-ask 数学核对（E-3，用户 C 完成引导后有真实预算）

```
dashboard: intakeRecommended=1200, intakeKcal=0, remainingKcal=1200
free-ask（"今天还能吃米饭吗"）: "可以安排。今天还剩约 1200 kcal，一份米饭（白，蒸）（约 150 g）约 174 kcal，在剩余范围内。"
手算: 剩余 = 1200 - 0 = 1200 ✅；份量热量 = 116 × 150 ÷ 100 = 174 ✅
```

回答数字与 dashboard 完全一致，热量数字全部来自食物库 ✅。

### 6.4 空输入（E-4）

```
free-ask 问"   "（空白）→ 400 {"error":{"code":"E_VALID_AI_EMPTY","message":"想问点什么都可以，先写一句吧","fields":{"question":"问题不能为空"}}}
recognize-food 空 description → 400 E_VALID_AI_EMPTY ✅
```

两者均在 `consumeQuota` 之前抛出，不消耗限额 ✅。**三期未重犯二期"内置异常吞错误码"问题**：429 `E_LIMIT_AI` 与 400 `E_VALID_AI_EMPTY` 的 code 均正确透出到响应体 ✅。

### 6.5 跨用户（E-6）

- schema 仅有 `ai_usage`（只存计数/token，**无任何会话/回答内容表**），不存在 A 会话内容被 B 读取的载体 ✅；
- 限额、ai_usage 行均按 userId 隔离（§5.5 实测）✅。

### 6.6 前端（F 项）

| 检查项 | 结果 |
| --- | --- |
| `/ai` 路由 | `routes.tsx` L68 指向 `AiPage`（非占位组件）✅ |
| `available:false` UI | `AiPage.tsx` L245/L267/L308：`available === false` → `<UnavailableNotice />`（COPY.aiUnavailable "AI 助手暂不可用…"），下方仍渲染规则内容，**非报错分支** ✅ |
| 食物识别确认链路 | 仅"确认记录"按钮触发 `confirmMutation` → `POST /meals`；识别查询本身零写操作 ✅ |
| ShareCard 隐私 | `ShareCardProps` 仅含 weekLabel/avgIntakeKcal/totalExerciseKcal/weightChangeKg(变化量，null→"—")/encouragement；**无邮箱、无绝对体重**；ReportPage 传入的是周报 delta ✅；Canvas 720×960 绘制 + `toDataURL('image/png')` 下载 |
| 提醒默认关闭 | `readReminderEnabled()` 默认 false；`maybeSendDailyReminder` 三重守卫（偏好开关 → `Notification.permission==='granted'` → 当日 `lastSentDate` 去重）；未开启绝不 `new Notification` ✅；`ReminderSettings` 挂载于 ProfilePage |
| 禁词 grep（web src 全量） | `失败/超标/请反思/坚持就是胜利/羞耻/罪恶/活该` 0 命中（唯一"减肥"出现于落地页产品自我描述，属品类词非评判语）✅ |
| 新增 vitest 真实性 | reminder 11 用例：FakeNotification 断言发送次数/标题/隔天重置/三重守卫，**真实断言非空跑** ✅；share-card 2 用例仅覆盖文件名纯函数（真实但薄，见 §7 OBS-1） |

---

## 7. 遗留问题清单

| ID | 严重度 | 描述 | 影响 | 建议 | 路由 |
| --- | --- | --- | --- | --- | --- |
| BUG-P3-1 | P2 | 医疗意图关键词表（`ai.constants.ts`）未覆盖"心情低落/心情不好/情绪低落"等低强度心理困扰表达；实测 `safetyFlag:false` 且消耗 1 次限额 | 心理困扰用户得不到固定就医引导，还会消耗限额（虽输出本身无害） | 关键词表增加 `心情低落/心情不好/情绪低落/压力大` 等词条；或在心理分组采用轻度模糊匹配 | Engineer |
| BUG-P3-2 | P2 | 医疗兜底分支（`ai.service.ts` L179）返回 `available:false` 但未携带 `reason:'ai_not_configured'`，违反 `shared-types/src/ai.ts` L18 注释的不变量（"available:false 时 reason 必为 ai_not_configured"） | 契约注释与实现不一致；前端目前只判 `available===false` 故 UI 不受影响 | L179 改为 `available: isAiConfigured()` 且 `...(isAiConfigured()?{}:{reason:'ai_not_configured'})`，或修订契约注释 | Engineer |
| BUG-P3-3 | P2（二期遗留，非三期回归） | `DELETE /data`（账号硬删除 R10.4）后，持旧 JWT 的任意需 `getProfile` 的请求（如 `GET /api/dashboard`）→ `userSettings.upsert` FK 约束违例 → **500 E_INTERNAL**，应为 401 | 删除账号后客户端残留 token 期间的所有请求得到 5xx；服务端刷错误日志 | JwtAuthGuard/策略增加用户存在性校验（查库 status），或 `ensureSettings` 捕获 FK 错误抛 401 | Engineer（记录） |
| OBS-1 | 观察项 | share-card 仅 2 个文件名纯函数用例，Canvas 绘制与隐私字段无自动化断言（本次为代码级人工核验） | 回归保护偏薄 | 可补：weightChangeKg=null 渲染"—"、props 不含 email 的类型级测试 | QA 自留 |

---

## 8. 智能路由判定

**Send To: Engineer** —— 3 项 P2 源码问题（BUG-P3-1 / BUG-P3-2 为三期代码，BUG-P3-3 为二期遗留边界）。三项均不阻塞三期验收（无 P0/P1，安全红线全部通过），可择期修复；测试侧无需返工（本次 7 个脚本断言 FAIL 中 4 个为验证脚本自身计数偏移，已人工复核源码行为正确并修正结论，非源码缺陷）。

---

## 9. 手算过程附录

1. **限额（B 账号 free_ask）**：基线 1（成功）+ 循环 49（成功）= 50 次全部 200；`ai_usage.free_ask=50`；第 51 次 → 429。手数与表一致。
2. **限额 SUM（A 账号）**：`2(daily_summary) + 2(today_plan) + 25(free_ask) + 20(food_recognize) = 49` → +1 free_ask = **50**（该次成功）→ 随后 free_ask / recognize-food / daily-summary 三连发全部 429。
3. **free-ask 数字**：C 账号 dashboard `remainingKcal=1200`（1200−0）；回答"还剩约 **1200** kcal"；份量热量 116 kcal/100g × 150 g ÷ 100 = **174** kcal，与回答"约 174 kcal"一致。
4. **规则兜底数据真实性**：米饭 150g → 116 × 150 ÷ 100 = 174 kcal，daily-summary basis "饮食记录合计 174 kcal" 一致。

## 10. 收尾记录

| 项 | 状态 |
| --- | --- |
| 3000 端口服务 | 已停止（后台任务 oJp5k0 killed，`curl /api/health` 返回 000 确认端口释放） |
| 测试账号 | qa-phase3-a（经 DELETE /data 硬删除）+ qa-phase3-b/c（SQL 清理，FK 级联）→ `users=0` ✅ |
| dev.db 终态 | users 0 / ai_usage 0 / meal_logs 0 / weight_logs 0 / water_logs 0 / exercise_logs 0 / **food_items 57（种子完好）** |
| 临时脚本 | `tmp_qa_phase3.py`、`tmp_qa_phase3_c.py`、token 临时文件 ×3（含目录外 1 个）已删除 ✅ |
| 源码/配置改动 | **零改动**（仅新建本报告 + 已清理的临时脚本） |
| 未完成子项 | 无（F 项 UI 分支为代码级+测试级确认，未起浏览器实测，已在 §6.6 标注核验方式） |
