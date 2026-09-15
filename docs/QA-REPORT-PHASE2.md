# QA-REPORT-PHASE2 —— 「轻生活」二期独立验证报告

- **执行人**：Edward（QA Engineer，software-qa-engineer-2）——**未参与二期实现**，全程独立实跑命令、自建请求、手算核对
- **执行日期**：2026-09-12
- **验证对象**：二期交付（运动 MET / 饮水 / 习惯 / 断食 / 周报+微量营养素 / 生活化工具 / 数据主权 / Docker+CI）
- **方法**：三套件回归 + 真实起服对抗性测试（自注册 3 个账号、自构造非法/越权请求、SQLite 直查落库）+ 前端静态验证

---

## 1. 结论摘要

### 总体判定：**通过（附 3 项 P2 遗留，无 P0/P1）**

| 验证域 | 结果 |
|---|---|
| 三套件回归 | ✅ core 84/84（覆盖率四项全部 ≥90%）· api 14/14 · web 38/38 |
| 二期接口对抗验证 | ✅ 58 项断言，55 项直过，3 项初判 FAIL 经甄别为 **2 个真实 P2 缺陷 + 1 个测试脚本自身预期错误（已修正认知，非产品缺陷）** |
| ★ 安全项（内容警告强制 / 跨用户隔离 / 硬删除级联） | ✅ 全部通过 |
| 数学核对（运动 kcal / 微量营养素日均 / 移动平均） | ✅ 与手算逐位一致 |
| 文案合规 | ✅ 禁词 0 命中，5 个新页面通读无贩卖焦虑表达 |
| 种子幂等 / 前端构建 / CI·Docker | ✅ 全部通过 |

**遗留问题**：P2 × 3（详见 §6），均不阻断发布，建议随下个迭代修复。

---

## 2. 回归结果（A 项，全部实跑）

| 套件 | 命令 | 结果 |
|---|---|---|
| core | `npm run test -w @qsh/core` | **84/84 通过**（7 个文件），覆盖率 **Stmts 99.69% / Branch 95.58% / Funcs 100% / Lines 99.69%**，四项 ≥90% 达标 |
| api | `npx vitest run --root apps/api`（按指引绕过 pretest 沙箱问题） | **14/14 通过** |
| web | `npx vitest run --root apps/web` | **38/38 通过**（7 个文件） |
| web typecheck | `tsc --noEmit` | 通过（exit 0） |
| web build | `npm run build -w @qsh/web` | 成功；PWA 产物 **`dist/sw.js`、`dist/workbox-*.js`、`dist/manifest.webmanifest`、icons/** 均生成（precache 6 entries）。注：WeightChart chunk 1,048 kB 超过 500 kB 警戒线（echarts 体积），仅性能提示，非缺陷 |

## 3. 各端点验证明细（B 项，对抗性）

服务以 `node apps/api/dist/apps/api/src/main.js` 启动（3000 端口），验证码从服务端进程日志抓取（共注册 A/B/C 三账号）。

### 3.1 运动（`/api/exercises/**`）
| # | 场景 | 期望（手算） | 实测 | 判定 |
|---|---|---|---|---|
| EX-1 | `GET /activities` | 15 条 MET 表 | 15 | ✅ |
| EX-3 | 试算 jogging(8.3) × 70kg × 30min | 8.3×70×0.5 = **290.5** | 290.5 | ✅ |
| EX-4 | 边界 minutes=1：walking_slow(3.0) × 80kg | 3×80/60 = **4.0** | 4.0 | ✅ |
| EX-5 | 边界 minutes=480：running(11.0) × 55.5kg | 11×55.5×8 = **4884.0** | 4884.0 | ✅ |
| EX-6/7 | 非法 activityCode | 400 + 中文提示 | 400，`E_VALID_INPUT`，message 含「运动类型」 | ✅ |
| EX-8/9 | minutes=0 / 481 | 400 | 400 / 400 | ✅ |
| EX-10 | 记录 cycling(6.8) 30min（档案体重 65kg） | 6.8×65×0.5 = **221.0** | 221.0 | ✅ |
| EX-11 | 记录 yoga(2.5) 60min | 2.5×65×1 = **162.5** | 162.5 | ✅ |
| EX-12 | `GET ?date=` 当日合计 | 221.0+162.5 = **383.5** | 383.5 | ✅ |
| EX-15 | B 用 A 的记录 id DELETE | 404 | 404 | ✅ |

### 3.2 饮水（`/api/water/**`）
| # | 场景 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| WA-1 | `POST {}` 缺省 | 记 250ml | 250 | ✅ |
| WA-2/3 | amountMl=0 / 2001 | 400 | 400 / 400 | ✅ |
| WA-4~7 | goal 499/8001 → 400；500/8000（边界值）→ 200 | 同左 | 一致 | ✅ |
| WA-8 | 记 250+500，goal 改 2500 | total=750, goal=2500 | 一致 | ✅ |
| WA-9 | `DELETE /last` | 撤销后 total=250 | 250 | ✅ |
| WA-10/11 | B 删 A 的记录 / B 空日撤销 | 404 / 404 | 一致 | ✅ |

### 3.3 习惯（`/api/habits/**`）
- 内置习惯 **6** 个；创建自定义习惯后列表 **7** 个 ✅
- **幂等**：同日重复打卡 2 次 → SQLite `habit_checkins` 仅 **1 行** ✅；`done:false` 取消后行删除（0 行）✅
- **连续天数（直接向 SQLite 插入昨日/前日/大前日打卡行做跨日验证）**：
  - 昨(D-1)、前(D-2)、大前(D-5) 已打，今日未打 → **currentStreak=2**（从昨天起算，断点不影响）✅，bestStreak=2 ✅
  - 补打今天 → **currentStreak=3** ✅
- B 打 A 的自定义习惯 → 404 ✅

### 3.4 断食（★ 安全项，`/api/fasting/**`）
| # | 场景 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| FA-1 | 未启用就 start | 400 | 400 | ✅ |
| FA-2 | ★ 未带 `disclaimerAckAt` 把 enabled 置 true | 400 | 400，原始响应：`{"data":null,"error":{"code":"E_VALID_INPUT","message":"开启前需要先阅读并确认内容警告"}}` | ✅（但见 §6 BUG-P2-1：错误码被吞） |
| FA-4 | 带 `disclaimerAckAt` 开启 | 200 且 enabled=true | 一致 | ✅ |
| FA-5 | `plan='18:6'` | `targetFastHours` 自动=18 | 18 | ✅ |
| FA-6/7/8 | targetFastHours=0 / 37、eatWindowStart='25:00' | 400 | 400 / 400 / 400 | ✅ |
| FA-9 | start | targetHours=18 | 18（但 HTTP **201**，见 §6 BUG-P2-2） | ⚠️ |
| FA-10 | 重复 start | 400 | 400 | ✅ |
| FA-11 | ★ B 查 `GET /fasting/current` | 看不到 A 的会话（null） | null | ✅ |
| FA-12/13 | stop → 2xx；无会话再 stop | 404 | 201 / 404 | ⚠️（201，同 BUG-P2-2） |

### 3.5 周报 + 微量营养素（★ 数学核对，`/api/report/weekly`）
前置：给 B 记 1 餐——食物库 id=5「全麦面包」（fiber 6.0、sodium 380、sugar 5.0 g/100g，SQLite 直查确认）× 200g。

| 项 | 手算公式 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| fiber dailyAvg | 6.0 × (200/100) ÷ 7 = 1.7143 → round2 | **1.71** | 1.71 | ✅ |
| sodium dailyAvg | 380 × 2 ÷ 7 = 108.571 → **108.57** | 108.57 | ✅ |
| sugar dailyAvg | 5.0 × 2 ÷ 7 = 1.4286 → **1.43** | 1.43 | ✅ |
| saturatedFat | 食物库为 null → 0 | 0 | ✅ |
| 10 项齐全 + DRI 方向 | 钠/糖/饱和脂肪=atMost，纤维/钙/铁/钾/VD/B12/镁=atLeast | 一致（`DRI_REFERENCES` 与响应逐项比对） | ✅ |
| referenceNote | 含《中国居民膳食营养素参考摄入量》来源声明 | 一致 | ✅ |
| days 数组 | 7 天 | 7 | ✅ |

### 3.6 数据主权（`/api/data/**`）
- **导出**：顶层键 = `meta / profile / goals / weights / meals / exercises / habits / water / settings`，与 PRD §9.1 **逐字一致** ✅；`meta` 含 app/schemaVersion/exportedAt ✅；`meals[].items[].name` = 「全麦面包」（来自食物库，非自定义名）✅
- **CSV 导入（csvText 路径，含 UTF-8 BOM）**：

  ```
  \ufeffdate,weightKg,note
  2026-01-05,72.5, morning        ← 合法
  2026-02-30,70.0,                ← 不存在的日期 → errors[3]
  2026-01-06,0,                   ← weightKg=0 → errors[4]
  2026-01-05,70.8,"含,逗号"       ← 合法，同日覆盖
  2026-01-07,69.2,
  ```
  结果：**imported=3 / skipped=2 / errors 行号={3,4}** 全部符合预期 ✅；SQLite 直查 `2026-01-05 → 70.8`（后行覆盖前行）✅；引号转义 note=`含,逗号` 解析正确 ✅
- **硬删除**：C 账号造数（体重/运动/饮水/打卡/断食设置+会话）→ `DELETE /api/data` → 200；SQLite 直查：**users 表无 C 行**，且全库 **0 条孤儿行**（`weight_logs/meal_logs/exercise_logs/water_logs/habit_checkins/fasting_settings/fasting_sessions` 中 user_id 不属于任何现存用户的行数均为 0）——**真·级联硬删除，不是只看 404** ✅

### 3.7 跨用户隔离（★ 安全项，二期新端点全覆盖）
| 场景 | 结果 |
|---|---|
| B 的运动/饮水/习惯/断食/周报/导出列表 | 全部看不到 A 的数据（列表为空或 404）✅ |
| B 用 A 的资源 id 删改（运动 EX-15 / 饮水 WA-10 / 习惯 HB-10） | 均 404（不泄露存在性）✅ |
| body 塞他人 `userId`（exercises POST、water POST） | 被忽略，数据归属 JWT 主体 ✅ |

### 3.8 文案合规（第 8 项）
- `apps/web/src` 全量 grep「失败 / 超标 / 请反思 / 坚持就是胜利」：**0 命中** ✅
- 补充 grep「惩罚 / guilt / shame / 肥胖 / 管住嘴」：仅命中 3 处**否定式正向表述**（「不设惩罚」「断签不惩罚」「无负罪感设计」），合规
- 通读二期 5 个新页面（exercise/habits/tools/fasting/report + settings-data）的全部中文文案：均为鼓励式表达，如「体重涨一点不用慌」「想吃了就吃一点，不用有负担」「新习惯加上了，不着急，慢慢来」「断签不清零」；断食内容警告含不适人群提示与「我们不会因为断食给你发任何提醒或推送」。**未发现贩卖焦虑/恐吓式表达** ✅

### 3.9 种子幂等（第 9 项）
`npm run db:seed -w @qsh/api` **连跑两次**：
- 两次输出均为 `食物库 created=0 updated=57 / MET created=0 updated=15 / 习惯 created=0 updated=6`
- 总数不变：food_items=57、met_activities=15、habit_definitions=6（内置）+1（测试期创建的用户自定义 habit，未被种子破坏）✅

### 3.10 前端（第 10 项）
- `tsc --noEmit` ✅、`vitest run` 38/38 ✅、`vite build` ✅（PWA 产物齐全，见 §2）
- 路由 12 组齐全：`/`、`/onboarding`、`/dashboard`、`/diary`、`/weight`、`/profile`、`/settings/data`、`/exercise`、`/habits`、`/tools`、`/fasting`、`/report`（另有 `/ai` 与兜底重定向）
- **后端未启动时的优雅降级（读码判定）**：✅ 不会白屏——
  - ExercisePage：`dayQuery.data?.logs ?? []`、`data?.totalKcal ?? 0` 空值兜底；饮水读 `local-cache` 本地缓存；mutation onError 给「暂时连不上服务，运动先自己记着，恢复后会同步」
  - HabitsPage / ReportPage：查询失败有 isEmpty 分支文案（「正在取回你的习惯…」「暂时拿不到周报，稍后再看看」）
  - FastingPage：全操作有 isNetworkError 分支文案
  - ToolsPage：纯前端计算（`@qsh/core` 纯函数），不依赖后端

## 4. ★ 安全项验证明细（汇总）
1. **内容警告强制（TC-30）**：服务端拒绝未携带 `disclaimerAckAt` 的开启请求（400 + 中文 message），双层 gate（前端本地 gate + 服务端强制）在代码中均有实现 → 通过
2. **跨用户隔离**：二期全部新端点（exercises/water/habits/fasting/data/report）均以 JWT `userId` 过滤；越权 404、body 注入 userId 被忽略 → 通过
3. **硬删除级联**：SQLite 直查 0 孤儿行 → 通过

## 5. 数学核对明细（汇总）
- **运动 kcal**：`MET × kg × min/60`，3 组常规 + minutes=1、480 两处边界，全部与返回值逐位一致（§3.1）
- **微量营养素日均**：`per100g × (grams/100) ÷ 7`，3 项正值逐位核对 + 1 项 null→0（§3.5）
- **移动平均**：导入 2026-01-05=70.8、01-07=69.2、今日=65 后 `GET /weights`：`movingAverage7 = [70.8, 70.0, 65]`——01-07 的 MA7=(70.8+69.2)/2=**70.0** 与手算一致（7 日窗口含当日）；01-05、09-12 窗口内仅自身 ✅

## 6. 遗留问题清单

| ID | 严重度 | 描述 | 影响 | 建议 | 责任人 |
|---|---|---|---|---|---|
| BUG-P2-1 | **P2** | **二期服务层自定义错误码被全局过滤器吞掉**：fasting/exercise/water/habits/data 服务抛的是 Nest 内置 `BadRequestException({code,message})`/`NotFoundException`，`AllExceptionsFilter.resolveHttp` 对 400/404 只提取 `message`、丢弃自定义 `code`，统一降级为 `E_VALID_INPUT` / `E_NOTFOUND_RESOURCE`。实测：内容警告缺失返回 `E_VALID_INPUT`（服务层期望 `E_VALID_DISCLAIMER_REQUIRED`）。共 8 个自定义码（E_VALID_DISCLAIMER_REQUIRED、E_VALID_FASTING_DISABLED/RUNNING、E_VALID_IMPORT_EMPTY、E_NOTFOUND_ACTIVITY/EXERCISE/WATER/HABIT/FASTING）到不了客户端，且未登记进 `ERROR_CODES`。一期约定（auth 模块用 `ApiException`，code 原样透出）被二期打破 | 前端只能靠中文 message 文案匹配来区分错误类型（脆弱、且文案改动即碎）；契约层 `ApiError.code` 退化为泛化值 | 二期服务改抛 `ApiException(status, code, message)`，并将新增错误码补入 `common/constants/error-codes.ts`；补一条 e2e 断言 `error.code` | 主理人（BUG 路由见 §7） |
| BUG-P2-2 | **P2** | `POST /fasting/start` 与 `POST /fasting/stop` 返回 **201**（未挂 `@HttpCode(HttpStatus.OK)`），而二期其他全部 POST 端点（含 exercises/water/habits/meals/data.import）均显式 200。实测 FA-9/FA-12 | 契约不一致：前端若硬判 200 会误判失败；api e2e 套件未覆盖 fasting 端点所以未拦住 | 两个方法补 `@HttpCode(HttpStatus.OK)`，或在共享契约中明确 2xx 皆可 | 主理人 |
| OBS-P2-3 | **P2（观察项）** | 账号硬删除后，旧 JWT 访问 `/auth/me` 返回 **404 `E_NOTFOUND_RESOURCE`** 而非 401。语义上「资源不存在」说得通，且不泄露信息；但按鉴权惯例已注销身份应 401，客户端会误以为 token 有效只是资源没了 | 边界场景体验，无安全风险（数据已删干净，实测确认） | 可选：JwtAuthGuard 后的 getMe 对「user 不存在」抛 401 `E_AUTH_UNAUTHORIZED` | 主理人（可延后） |

**注**：对抗验证中另有一项初判 FAIL（DS-12「B 导出含全麦面包餐」）经甄别为 **QA 测试脚本自身预期错误**（B 在周报验证时自己记过该餐，属 B 的合法数据），非产品缺陷，按规则由 QA 自行修正认知，不计入遗留问题。

## 7. 智能路由判定
- **发现 2 个真实缺陷（BUG-P2-1、BUG-P2-2）+ 1 个观察项（OBS-P2-3）→ Send To: Engineer（当前为实现者主理人本人修复——团队成员实例限流中）**
- 测试脚本 1 处预期错误由 QA 自行修正（Send To: QA，已闭环）
- 三套件回归 0 失败 → 无需路由

## 8. 收尾记录
- **停掉的端口**：3000（API 服务后台任务已 kill，`curl` 复测连接拒绝 `000`）✅
- **清理的临时文件**：`%TEMP%/qsh_p2_api_test.py`、`%TEMP%/qsh_p2_followup.py`、`/tmp/qsh_a_token`、`/tmp/qsh_b_token`、`/tmp/qsh_b_resp.json`、`/tmp/qsh-api.log` ✅
- **测试数据**：3 个 QA 账号（qa-p2-a/b/c@test.local）及其全部业务行、验证码行已从 `apps/api/prisma/dev.db` 删除；users 表恢复为空。种子数据未动（57/15/6）
- **源码/配置**：未修改任何文件（符合硬约束）；本报告为本轮唯一新建产物
- **未完成子项**：无（全部 10 项验证域均实际执行；Docker/CI 仅做配置审查与产物核对，未实际 `docker compose up`——本机未验证容器构建，如实说明）

---

## 9. 修复轮次（P2×3 回炉 · 2026-09-12 15:3x，主理人执行）

> 修复方式：按一期既有约定改二期实现（`ApiException` + `ERROR_CODES`），**未放宽任何校验、未改契约形态**。

### 9.1 修复内容

| ID | 修复 | 涉及文件 |
| --- | --- | --- |
| **BUG-P2-1** | 二期 5 个服务层的 Nest 内置异常（`BadRequestException`/`NotFoundException`）全部替换为 `ApiException(status, ERROR_CODES.X, message)`，自定义错误码不再被过滤器吞掉；`ERROR_CODES` 新增 9 个二期码（`E_NOTFOUND_ACTIVITY/EXERCISE/WATER/HABIT/FASTING`、`E_VALID_DISCLAIMER_REQUIRED/FASTING_DISABLED/FASTING_RUNNING/IMPORT_EMPTY`） | `exercise/water/habits/fasting/data` 5 个 `*.service.ts`、`common/constants/error-codes.ts` |
| **BUG-P2-2** | `/api/fasting/start`、`/api/fasting/stop` 加 `@HttpCode(HttpStatus.OK)`，与其他 POST 端点一致 | `fasting/fasting.controller.ts` |
| **OBS-P2-3** | 账号硬删除后旧 JWT 访问 `/auth/me` 由 404 改为 **401 `E_AUTH_INVALID_TOKEN`**（token 不再对应有效会话，语义为"请重新登录"而非"资源不存在"） | `users/users.service.ts` `getMe()` |

### 9.2 修复后实测（真实 HTTP，非 mock）

| 步骤 | 结果 |
| --- | --- |
| 未带 `disclaimerAckAt` 开启断食 | **400 `E_VALID_DISCLAIMER_REQUIRED`**（此前为 `E_VALID_INPUT`）✅ |
| 带确认时间开启 | 200，`enabled=true` ✅ |
| `POST /fasting/start` | **200**（此前 201）✅ |
| `POST /fasting/stop` | **200** ✅ |
| `DELETE /data` | 200 `{deleted:true}` ✅ |
| 删除后旧 JWT 访问 `/auth/me` | **401 `E_AUTH_INVALID_TOKEN`**（此前 404）✅ |

### 9.3 回归与收尾

- 修复后三套件回归：**core 84/84、api 14/14、web 38/38 = 136/136 全绿**
- 验证服务已停止（3000 端口已释放）；本轮验证用账号 `p2fix@test.local` 已随硬删除流程清除
- **当前遗留：P0 = 0，P1 = 0，P2 = 0**（仅存已知范围外事项：Docker 容器构建未在本机实跑）
