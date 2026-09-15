# QA 测试报告 — T01 `@qsh/core` 热量计算引擎

- **报告人**：严过关（QA 工程师）
- **被验证对象**：`@qsh/core`（T01，工程师 Alex 交付）
- **验证方式**：**独立重跑 + 自写脚本复算**（不采信工程师自述）
- **验证时间**：2026-09-12 10:51–10:54（本地）
- **工作根目录**：`C:/Users/18049/WorkBuddy/2026-09-12-10-33-46/qingshenghuo/`
- **Node**：v22.22.2 ｜ **npm**：10.9.7

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| **总体结论** | ✅ **通过（有条件）** — 引擎实现与设计一致、数值正确、门禁达标；仅存 1 项需上游裁定的设计/PRD 冲突（见 §5） |
| **测试通过率** | 工程师套件 **58/58 通过**；QA 独立套件 **14/14 通过**（合计 72/72，100%） |
| **覆盖率（四项）** | Statements **99.62%** ｜ Branches **97.33%** ｜ Functions **100%** ｜ Lines **99.62%**（阈值 90%，**全部达标**） |
| **typecheck** | `@qsh/core` + `@qsh/web` 均 `tsc --noEmit` 通过（exit 0） |
| **web 构建** | `vite build` 成功（47 modules，`dist/` 产出正常） |
| **数据层** | `SCHEMA.sql` 一次执行成功，建表 **20** 张，`ON DELETE CASCADE` 真实生效 |
| **遗留问题数** | **P0：0** ｜ **P1：1** ｜ **P2：5** |
| **智能路由判定** | **NoOne**（本轮源码/测试无需改动）＋ **遗留 P1 交 Architect/PM 裁定设计缺陷（S3）** |

> 关键判定一句话：**工程师报告的「58 绿 / 99.62%」经独立重跑属实；引擎数值经我手算逐字段核对全部正确；唯一实质问题是 PRD §8.1 TC-02 与 ARCHITECTURE §4.5 的校验规则互相打架 —— 这是设计缺陷（S3），不是源码 Bug，也不是测试 Bug。**

---

### 1.1 第 2 轮回归结论（T01-FIX 后 · 2026-09-12 11:07–11:11）

| 项 | 第 1 轮（T01） | **第 2 轮（T01-FIX）** |
| --- | --- | --- |
| 工程师套件 | 58/58 通过 | ✅ **64/64 通过**（validate 16→22，+6 用例） |
| QA 独立套件 | 14/14 通过 | ✅ **51/51 通过**（契约验证，验后清理） |
| 覆盖率（四项） | 99.62 / 97.33 / 100 / 99.62 | ✅ **100 / 100 / 100 / 100**（Stmts、Lines 301/301；Branches 88/88；Funcs 26/26） |
| typecheck（core + web） | 通过 | ✅ 均 `tsc --noEmit` exit 0 |
| web 构建 | 1.43s 成功 | ✅ **1.50s 成功**（47 modules transformed） |
| 遗留问题数 | **P0：0 ｜ P1：1 ｜ P2：5** | ✅ **P0：0 ｜ P1：0 ｜ P2：0** |
| 智能路由判定 | NoOne ＋ S3 交 Architect/PM 裁定 | ✅ **NoOne（全绿；Q-01~Q-06 全部闭环）** |

> **第 2 轮一句话结论**：主理人裁定的 **方案 A**（`E_WEEKLY_LOSS` 由硬错误降级为**非阻断告警**）已由 Architect（§4.5 / D13）/ PM（§8.1 TC-02）/ Engineer 三方一致落地。我作为**独立验证方逐项自行复跑** —— 64/64 全绿、覆盖率**真达四项 100%**、web 构建与双端 typecheck 全绿、TC-02 恰好 2 条告警且逐字段精确、硬错误通道仍在、推导链路与显式链路**数值完全一致**。**Q-01~Q-06 全部闭环，本轮遗留 P0 = 0，P1 = 0。**
>
> ✅ **本轮新增 ★ 契约验证 51/51 全通过**；工程师关于 D 项的两个自述（问题 1 fixture 调整、问题 2 笔误澄清）经我复核**均判定有效**（详见 §10.4）。

---

## 2. 环境与命令（原始输出片段）

### 2.1 回归测试（自己跑）
```
$ npm test -w @qsh/core
 RUN  v2.1.9  packages/core     Coverage enabled with v8
 ✓ test/macros.test.ts   (5 tests)
 ✓ test/boundaries.test.ts (4 tests)
 ✓ test/acceptance.test.ts (7 tests)
 ✓ test/validate.test.ts (16 tests)
 ✓ test/units-date.test.ts (13 tests)
 ✓ test/budget.test.ts   (13 tests)

 Test Files  6 passed (6)
      Tests  58 passed (58)          ← 与工程师自述一致
   Duration  904ms

 % Coverage report from v8
---------------|---------|----------|---------|---------|-------------------
File           | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
---------------|---------|----------|---------|---------|-------------------
All files      |   99.62 |    97.33 |     100 |   99.62 |
 calorie       |   99.54 |    96.42 |     100 |   99.54 |
  validate.ts  |      99 |     93.1 |     100 |      99 | 131
  (其余 calorie/* |   100 |     100 |    100 |   100 |)
 date/daykey.ts |     100 |      100 |     100 |   100 |
 units/convert.ts|    100 |      100 |     100 |   100 |
---------------|---------|----------|---------|---------|-------------------
```

### 2.2 覆盖率明细（`packages/core/coverage/coverage-summary.json` 原始值）
```json
"total": {"lines":{"total":264,"covered":263,"pct":99.62},
          "statements":{"total":264,"covered":263,"pct":99.62},
          "functions":{"total":26,"covered":26,"pct":100},
          "branches":{"total":75,"covered":73,"pct":97.33}}
```
- 唯一未覆盖点：`validate.ts` 第 131 行分支（`tooHigh` 为 `false` 的一侧），阈值 90% 仍轻松达标，无实质风险。

### 2.3 typecheck
```
$ npm run typecheck
> @qsh/core@0.1.0 typecheck  → tsc -p tsconfig.json --noEmit     （exit 0）
> @qsh/web@0.1.0  typecheck  → tsc -p tsconfig.json --noEmit     （exit 0）
```

### 2.4 web 构建
```
$ npm run build -w @qsh/web
vite v5.4.21 building for production...
✓ 47 modules transformed.
dist/index.html                  0.58 kB
dist/assets/index-sFPXpITx.css  10.10 kB
dist/assets/index-Bsae2noz.js  169.73 kB │ gzip: 56.38 kB
✓ built in 1.43s
```

---

## 3. 用例执行明细表

| 用例 ID | 场景 | 期望 | 实际 | 结论 |
| --- | --- | --- | --- | --- |
| TC-01 | 女 30/165/60 久坐，周减 0.5kg | BMR 1320、TDEE 1584、缺口 550、cap 475.3、摄入 1200、双标志 true | 全部一致 | ✅ 通过 |
| TC-02（推导） | 同上，目标 6 周减 12kg（推导周减 2.0） | 原始缺口 2200、截断至 475.3、摄入 1200 | 全部一致 | ✅ 通过 |
| TC-02（显式 `weeklyLossKg:2`） | PRD §8.1 原文"用户设置每周减 2kg" | 强制截断 + 温和提示 | **抛 `CalorieInputError`（E_WEEKLY_LOSS）** | ⚠️ **冲突，见 §5** |
| TC-04 极低体重 | 女 14/150/20 | 不崩、BMR>0、触下限 1200 | BMR 907、floorApplied true、摄入 1200 | ✅ 通过 |
| TC-05 大年龄 | 女 100 | 不崩、结果为正 | BMR 889、TDEE 1067、摄入 1200 | ✅ 通过 |
| TC-06 触下限（男 40/175/70） | 缺口未超上限但触下限 | 摄入 1500、floorApplied true、capped false | 与设计一致 | ✅ 通过 |
| TC-07 30% 上限未触下限 | 男 30/180/85 中度，周减 1.5 | capped true、floorApplied false | eff 851.0、摄入 1986 | ✅ 通过 |
| TC-08 同时触上下限 | 男 30/165/70 久坐，周减 1.4 | 双标志 true、摄入=floor | 与设计一致 | ✅ 通过 |
| TC-09 活动系数 5 档 | BMR × 1.2/1.375/1.55/1.725/1.9 | 5 档正确 | 全部正确 | ✅ 通过 |
| TC-10 默认宏量 | 1200 → 75/33.3/150 | 一致 | 一致 | ✅ 通过 |
| TC-11 自定义宏量 | 30/30/40 和为 100 | 正确换算；和≠100 报错 | 一致 | ✅ 通过 |
| 边界-错误码 | age/height/weight/targetWeeks/gender/activity/macro | 对应 E_* | 全部命中 | ✅ 通过 |
| safe 入口 | 非法输入 | `{ok:false,errors}` 且不抛错 | 一致 | ✅ 通过 |
| calc 入口 | 非法输入 | 抛 `CalorieInputError` | 一致 | ✅ 通过 |
| 单位换算 | kcal↔kJ(4.184) 往返 | 一致 | 一致 | ✅ 通过 |
| 本地日期 | `toLocalDateKey` 与本地 getters 拼接一致 | 一致 | 一致 | ✅ 通过 |

---

## 4. 独立复算明细（QA 手算 vs 引擎输出）

> 方法：QA 自写临时脚本 `packages/core/test/_qa_verify.test.ts`（**不引用工程师任何断言**，期望值全部手工推导），仅调用 `../src/index` 公共 API。**14/14 通过，验后已删除。**

### 4.1 TC-01 逐字段对照（女 30 岁 165cm 60kg 久坐，周减 0.5kg）

| 字段 | QA 手算推导 | 引擎输出 | 一致 |
| --- | --- | --- | --- |
| bmrFloat（中间值） | 10×60+6.25×165−5×30−161 = **1320.25** | （输出层取整） | — |
| `bmr` | `Math.round(1320.25)` = **1320** | 1320 | ✅ |
| `tdee` | `Math.round(1320.25×1.2=1584.3)` = **1584** | 1584 | ✅ |
| `targetDeficitRaw` | 0.5×7700÷7 = **550.0** | 550 | ✅ |
| `deficitCap` | `round1(1584.3×0.3=475.29)` = **475.3** | 475.3 | ✅ |
| `effectiveDeficit` | `min(550, 475.29)` → round1 = **475.3** | 475.3 | ✅ |
| `isDeficitCapped` | 550 > 475.29 → **true** | true | ✅ |
| `intakeRecommended` | `max(1584.3−475.29=1109.01, 1200)` = **1200** | 1200 | ✅ |
| `floorApplied` | 1109.01 < 1200 → **true** | true | ✅ |
| `safetyFloor` | **1200** | 1200 | ✅ |
| `macros` | 1200×0.25÷4=**75.0**；1200×0.25÷9=**33.3**；1200×0.5÷4=**150.0** | 75 / 33.3 / 150 | ✅ |
| `weeklyLossEffectiveKg` | `(1584.3−1200)×7÷7700` = 0.3494 → **0.35** | 0.35 | ✅ |
| `etaWeeks` | `5÷0.3494` = 14.3119 → **14.31** | 14.31 | ✅ |
| `safetyMessages` | 2 条鼓励式中文，**不含**「失败/超标/警告/请反思/坚持就是胜利/必须」 | 2 条，通过禁用词扫描 | ✅ |

### 4.2 其余独立复算

| 场景 | QA 手算 | 引擎 | 一致 |
| --- | --- | --- | --- |
| TC-02 推导周减 2.0 | raw 2200.0；eff 475.3；intake 1200 | raw 2200、cap 475.3、eff 475.3、intake 1200 | ✅ |
| 30% 上限未触下限（男 30/180/85 中度，周减 1.5） | BMR 1830、TDEE 2836.5、cap 850.95、eff 851.0、intake `round(1985.55)=1986`、capped true / floor false | bmr 1830、tdee 2837、eff 851、intake 1986、flags true/false | ✅ |
| 活动系数 5 档 | 1830×{1.2,1.375,1.55,1.725,1.9} = {2196,2516.25,2836.5,3156.75,3477} | 逐档 round 后全部一致 | ✅ |
| 默认宏量 | 75 / 33.3 / 150 | 一致 | ✅ |
| 自定义宏量 30/30/40 @2000 | 150 / 66.7 / 200 | 一致 | ✅ |
| 极低体重（女 14/150/20） | BMR `round(906.5)=907`、floorApplied true、摄入 1200 | bmr 907、floor true、1200 | ✅ |
| 大年龄（女 100） | BMR 889、TDEE 1067、结果为正 | 一致 | ✅ |
| 错误码边界 | E_AGE/E_HEIGHT/E_WEIGHT/E_TARGET_WEIGHT/E_TARGET_WEEKS/E_GENDER/E_ACTIVITY/E_MACRO_SUM | 全部命中 | ✅ |
| safe vs calc 入口 | safe 不抛错返回 `{ok:false}`；calc 抛 `CalorieInputError` | 一致 | ✅ |
| 单位换算 | kcal→kJ→kcal 往返 ±1e-6 | 一致 | ✅ |
| 本地日期 | `toLocalDateKey(d)` == 本地 getters 拼接 | 一致 | ✅ |

> **独立复算结论**：引擎在 TC-01、TC-02、TC-07、5 档活动系数、宏量、边界、单位、日期等 **全部关键路径上与 QA 手算完全吻合**，未发现任何数值偏差或共享错误假设。

---

## 5. ★ 重点冲突判定（D 项）

### 5.1 实际调用记录（真实行为）

**调用 ①：`calcCalorieBudget({ ...TC-02 参数, weeklyLossKg: 2 })`（女 30/165/60 久坐）**
```
→ 抛出 CalorieInputError，errors = [ E_WEEKLY_LOSS ]
   message: "每周减重建议更温和一些（不超过当前体重的 2%）"
```

**调用 ②：`safeCalcCalorieBudget(同一输入)`**
```json
{ "ok": false,
  "errors": [{ "code": "E_WEEKLY_LOSS", "field": "weeklyLossKg",
               "message": "每周减重建议更温和一些（不超过当前体重的 2%）" }] }
```

**调用 ③（对照）：`calcCalorieBudget` 用「目标 6 周减 12kg」推导出同一 weeklyLoss=2.0**
```
→ 正常返回：targetDeficitRaw 2200 → 被 30% 上限截断为 475.3 → intakeRecommended 1200
```
即：**同一 weeklyLoss=2.0，显式传被"拒绝"，推导来的被"截断+给提示"。**

### 5.2 冲突本质

| 来源 | 原文 | 期望用户可见行为 |
| --- | --- | --- |
| **PRD §8.1 TC-02** | "用户设置每周减 2kg → 缺口 2200/天超过 TDEE 30%，系统**强制截断**并提示调整为更可持续的目标" | 接受输入 → 截断 → 温和提示 |
| **ARCHITECTURE §4.5** | `weeklyLossKg > weightKg × 0.02` → `E_WEEKLY_LOSS`（**硬错误**，`calcCalorieBudget` 抛错） | 拒绝输入 → 报错 |
| **同一行的自我矛盾** | §4.5 该行括注却写「温和上限**提示值**，不截断计算」 | "提示值"应**非阻断** |
| **constants.ts** | `WEEKLY_LOSS_MAX_RATIO` 注释亦写「温和提示值，不截断计算」 | 同上 |

根本问题：**设计同时安置了两道"温和上限"防线 ——（a）周减重 ≤ 体重×2% 的硬校验门、（b）缺口 ≤ TDEE×30% 的截断门。PRD 选择让 (b) 作为用户可见行为，而设计新增的 (a) 把 (b) 完全遮蔽了。**

### 5.3 QA 判定

> **判定：设计缺陷（S3）**，兼含"PRD ↔ 设计"文档冲突。
>
> **理由**：
> 1. 源码 `validate.ts` **忠实实现**了 §4.5 的错误码表，本身无逻辑错误 → **非源码 Bug（S1）**。
> 2. 工程师测试 `acceptance.test.ts:94–108` 已**显式断言**该抛错行为，断言与设计一致 → **非测试 Bug（S2）**。
> 3. 矛盾出在**设计文档 §4.5 自相矛盾**（"提示值"却配硬错误码），且**与 PRD §8.1 TC-02 的验收期望直接冲突** → 定性为 **S3 设计缺陷**。
> 4. 工程师用「推导 weeklyLoss=2.0」绕过校验，使验收 fixture **内部自洽但未真实覆盖 PRD 原文的输入形态**，属于对冲突的"规避"而非"解决"。
>
> **影响面（务必如实评估，避免高估）**：
> - **前端 UI 不受影响**：`CalorieCalculator.tsx` 不提供 `weeklyLossKg` 输入框（走推导），用户永远走不到该错误分支；
> - **用户可见结论与 PRD 一致**：截断值 475.3、摄入 1200 均正确；
> - **实际受损路径**：仅"服务端/API 显式传入超限 `weeklyLossKg`"的调用会从"截断+提示"退化为"拒绝报错"。

### 5.4 修复建议（二选一，需上游决策）

| 方案 | 做法 | 责任人 |
| --- | --- | --- |
| **方案 A（推荐，符合 PRD 语义）** | 把 `E_WEEKLY_LOSS` 从**硬错误降级为温和告警**：`validateCalorieInput` 仅保留 `weeklyLossKg <= 0 / 非有限值` 为硬错误；对"超体重×2%"改为写入 `CalorieResult.warnings[]`（或新增 `safetyMessages` 条目），**让 `min(rawDeficit, cap)` 成为缺口唯一防线** | **Engineer**（改 `validate.ts` + `types.ts` 增加 warnings 通道） |
| **方案 B（保硬校验）** | 保留硬拦截，但**修订 PRD §8.1 TC-02 文案**：明确"显式 weeklyLossKg 超体重 2% 为**被拒绝的非法输入**，逐字段温和提示"，并说明截断行为仅适用于推导链路 | **PM（Alice）改 PRD + Architect（Bob）修 §4.5 自相矛盾的括注** |

> **本轮路由**：源码与测试**无需改动**（S3 不是代码缺陷）→ **NoOne**。上表 P1 需先由 **Architect + PM** 拍板，再决定是否派 **Engineer** 实施方案 A。

---

## 6. 静态合规核验结果（C 项）

| # | 核验项 | 方法 | 结果 |
| --- | --- | --- | --- |
| C1 | `packages/core/package.json` 的 `dependencies` 为空或不存在 | `JSON.parse` 检查 | ✅ **不存在 `dependencies` 键**（仅 `devDependencies`：vitest / coverage-v8 / typescript）。零运行时依赖成立 |
| C2 | `src/**` 无 `Date.now(` / `fetch(` / `process.env` / `require(` / IO | `grep -rn` 逐模式 | ✅ 全部 `(none)`；仅 `daykey.ts` 的**注释**出现 `Date.now()` 与 `toISOString()`（说明性文字，非调用）；无 `node:` 导入、无 `fs.`、无 `localStorage`、无 `XMLHttpRequest` |
| C3 | 运算顺序与 ARCHITECTURE §4.2 **逐行一致**（先 `min(raw,cap)`，后 `max(tdee−eff, floor)`） | 通读 `formulas.ts:81–139` | ✅ 1→13 步顺序与 §4.2 完全一致；第 6 步 `Math.min(rawDeficit, cap)` 在前，第 9 步 `Math.max(rawIntake, floor)` 在后，**下限优先级更高**，与 PRD §5.3"边界与顺序约定"一致 |
| C4 | K4 合规：`messages.ts` 与全部 UI 文案**不含**禁用词 | `grep -rn` 扫 `packages/core/src` 与 `apps/web/src` | ✅ `messages.ts` 两条文案均为鼓励式；`apps/web/src` **零命中**「失败/超标/警告/请反思/坚持就是胜利」。⚠️ 唯一命中：`validate.ts:24` 的 `CalorieInputError.message` 含「失败」，但该消息**仅服务端/日志/单测可见**（前端走 `safeCalc*`，渲染的是逐字段 `ValidationError.message`，均鼓励式）→ 记为 **P2**，非 UI 违规 |
| C5 | 公共 API 与设计一致 | 对照 `index.ts` 导出与 §4 类图 | ✅ `calcCalorieBudget` / `safeCalcCalorieBudget` / `validateCalorieInput` / `calcBMR` / `calcTDEE` / `calcMacros` / `buildSafetyMessages` / `toLocalDateKey` 等导出面与设计一致；工程师额外拆分的 `engine.ts`、`rounding.ts` 仅作**内部组织**，公共 API 形态未偏离设计 |

---

## 7. 数据层核验结果（E 项）

> 方法：Python 3.13.12 内置 `sqlite3` 于 `:memory:` 执行 `docs/SCHEMA.sql`（临时脚本 `docs/_qa_schema_check.py`，验后已删）。

```
STEP1 执行 SCHEMA.sql: OK
STEP1 建表数量 (用户表): 20                                   ← 应为 20，✅
STEP2 PRAGMA foreign_keys 当前值: 1                            ← 脚本已 PRAGMA foreign_keys = ON
STEP2 插入 user id=1
STEP2 删除前 weight_logs=1 meal_logs=1
STEP2 删除后 weight_logs=0 meal_logs=0
STEP2 CASCADE 生效: 是                                        ← ✅ 级联删除真实生效
STEP2 serving_units 存储回读: [{"unit": "碗", "grams": 200, "isDefault": true, "label": "1碗"}]
STEP3 JSON 往返一致: 是                                       ← ✅ serving_units 可存 JSON 字符串
```

| # | 核验项 | 结果 |
| --- | --- | --- |
| E1 | `SCHEMA.sql` 能否一次成功执行 / 建表数量 | ✅ 一次成功；用户表 **20** 张（与 ARCHITECTURE §3.1 一致） |
| E2 | `ON DELETE CASCADE` 是否真实生效 | ✅ 开 `PRAGMA foreign_keys=ON` 后，删 `users` 行 → `weight_logs` / `meal_logs` 子行均归零 |
| E3 | `food_items.serving_units` 可否存 JSON 字符串 | ✅ 往返一致（UTF-8 中文正常） |

---

## 8. 遗留问题清单

| ID | 严重度 | 描述 | 影响 | 建议 | 责任人 |
| --- | --- | --- | --- | --- | --- |
| **Q-01** | **P1** | **PRD §8.1 TC-02 与 ARCHITECTURE §4.5 冲突**：显式 `weeklyLossKg=2`（60kg 的 3.3%/周）被 `E_WEEKLY_LOSS` 硬拦截抛错，而非 PRD 期望的"截断 + 温和提示"。§4.5 自身括注"提示值，不截断计算"与"硬错误码"矛盾 | 服务端/API 显式传入超限周减重时，用户可见行为从"温和纠偏"退化为"报错拒绝"；前端 UI 与用户可见结论**不受影响** | 采用 §5.4 方案 A（把 `E_WEEKLY_LOSS` 降级为 `warnings[]` 非阻断告警）或方案 B（修订 PRD 措辞） | **Architect(Bob) + PM(Alice) 裁定 → 若选 A 由 Engineer(Alex) 实施** |
| **Q-02** | P2 | `CalorieInputError.message` 含 PRD §7 禁用词「失败」（`validate.ts:24`） | 仅服务端日志/单测可见，**不渲染到 UI**，无用户可见风险 | 建议改为「热量引擎输入校验未通过」等中性措辞，彻底规避合规扫描告警 | Engineer（低优先） |
| **Q-03** | P2 | PRD §8.1 TC-02 写 `cap = 474.9`，与公式值 `475.3` 不符（已登记为 ARCHITECTURE D2） | 引擎按公式输出 475.3（正确）；PRD 数字为笔误 | **PM 更新 PRD TC-02 的 cap 为 475.3**（或标注"以公式为准"） | PM(Alice) |
| **Q-04** | P2 | `acceptance.test.ts:125` 变量 `tdeeFloat` 实际承载的是 **BMR 浮点值**（1830），第 137 行才乘 `1.55` | 命名误导，易致后续维护误读；数值本身正确 | 重命名为 `bmrFloat` | Engineer（清洁度） |
| **Q-05** | P2 | `constants.ts` 的 `WEEKLY_LOSS_MAX_RATIO` 注释「温和提示值，不截断计算」与 `validate.ts` 的硬错误实现不一致 | 与 Q-01 同源，属文档/实现表述不一致 | 随 Q-01 一并裁定后统一措辞 | Architect |
| **Q-06** | P2 | `validate.ts:131` 分支（`tooHigh=false` 侧）未被覆盖 | 覆盖率 97.33% 分支仍远超 90% 门禁，无功能风险 | 可选：补一条"周减重恰在 2% 边界内"用例 | QA（可选） |

---

## 9. 附：本次验证使用与清理的临时产物

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| `packages/core/test/_qa_verify.test.ts` | QA 独立复算脚本（14 用例，手算期望） | ✅ 已删除 |
| `docs/_qa_schema_check.py` | 数据层 sqlite 核验脚本 | ✅ 已删除 |

> 本报告全部结论均来自**真实执行的命令输出**；工程师自述仅作交叉比对，未直接采信。

---

## 10. 第 2 轮回归验证（T01-FIX）

- **验证人**：严过关（QA 工程师，**独立验证方，未采信工程师自述**）
- **被验证对象**：T01-FIX（`E_WEEKLY_LOSS` 降级为 `W_WEEKLY_LOSS_AGGRESSIVE` 非阻断告警）
- **对应上游决策**：主理人裁定**方案 A**；Architect 改 `ARCHITECTURE.md` §4.5 + D13；PM 改 `PRD.md` §8.1 TC-02；Engineer 改源码 + 测试
- **验证时间**：2026-09-12 11:07–11:11（本地）｜**环境**：Node v22.22.2 ｜ npm 10.9.7

### 10.1 复跑原始输出（A 项 · 全部我自己跑）

**A1 · `npm test -w @qsh/core`**
```
 RUN  v2.1.9  packages/core     Coverage enabled with v8
 ✓ test/boundaries.test.ts (4 tests)
 ✓ test/macros.test.ts     (5 tests)
 ✓ test/units-date.test.ts (13 tests)
 ✓ test/budget.test.ts     (13 tests)
 ✓ test/acceptance.test.ts (7 tests)
 ✓ test/validate.test.ts   (22 tests)

 Test Files  6 passed (6)
      Tests  64 passed (64)        ← 工程师自述 64/64 属实（第 1 轮 58 → 本轮 64）
   Duration  1.10s
```

**A2 · `packages/core/coverage/coverage-summary.json`（原始 total 值）**
```json
"total": {"lines":{"total":301,"covered":301,"pct":100},
          "statements":{"total":301,"covered":301,"pct":100},
          "functions":{"total":26,"covered":26,"pct":100},
          "branches":{"total":88,"covered":88,"pct":100}}
```
> ✅ **四项确为 100%**。第 1 轮遗留的 `validate.ts` 「`tooHigh=false` 侧未覆盖」（branches 97.33%）已被新增用例（`weeklyLossKg=1.2` 恰在体重 ×2% 内不触发）**真实补齐** —— 覆盖点由 75 增至 88，全部命中。**Q-06 关闭。**
> v8 文本报表逐文件 100%（constants / engine / formulas / macros / messages / rounding / validate / daykey / convert）。

**A3 · `npm run build -w @qsh/web`**
```
vite v5.4.21 building for production...
✓ 47 modules transformed.
dist/index.html                   0.58 kB │ gzip:  0.49 kB
dist/assets/index-DDF9UpUN.css   10.29 kB │ gzip:  2.72 kB
dist/assets/index-Bt1_1XQP.js   170.43 kB │ gzip: 56.69 kB │ map: 739.70 kB
✓ built in 1.50s
```
> 工程师自述「1.44s 成功」属实（1.50s 为正常环境抖动，47 modules 一致）。

**A4 · TypeScript 编译**
```
$ (packages/core) npx tsc -p tsconfig.json --noEmit   → exit 0
$ (apps/web)      npx tsc -p tsconfig.json --noEmit   → exit 0
```

### 10.2 ★ 契约验证明细（B 项）

> 方法：`esbuild` 把**真实** `packages/core/src/index.ts` 打包为临时 ESM 模块，再由我自写的 `packages/core/test/_qa_round2.mjs`（**期望值全部手工推导，不引用工程师任何断言**）独立断言。**结果 51/51 全通过（exit 0），验后临时文件已删除。**

| # | 验证项 | 断言要点 | 结果 |
| --- | --- | --- | --- |
| B1 | **TC-02 新语义**（显式 `weeklyLossKg=2`） | **不抛错**；`bmr=1320`、`tdee=1584`、`targetDeficitRaw=2200.0`、`deficitCap=475.3`、`effectiveDeficit=475.3`、`isDeficitCapped=true`、`intakeRecommended=1200`、`floorApplied=true`、`safetyFloor=1200` 逐字段精确；`warnings` **恰好 2 条** = `[W_WEEKLY_LOSS_AGGRESSIVE, W_FLOOR_APPLIED]`；`safetyMessages` **仍 2 条**（floor→capped 顺序、语义未破坏）；`safeCalcCalorieBudget` 返回 `{ok:true}` 且 `result.warnings` 同 2 条 | ✅ 18/18 |
| B2 | **硬错误保留** | `weeklyLossKg` = `NaN`/`Infinity`/`0`/`-1` → `validateCalorieInput.errors` 含 `E_WEEKLY_LOSS`，且 `calcCalorieBudget` 抛 `CalorieInputError`（`instanceof` 校验） | ✅ 8/8 |
| B3 | **告警不阻断** | `W_WEEKLY_LOSS_AGGRESSIVE` 命中（`weeklyLossKg=5`）时 `errors` **必为空** | ✅ 2/2 |
| B4 | **推导链路 vs 显式链路一致性**（D13 核心收益） | `deriveWeeklyLossKg(60,52,4)=2.0`；两条链路**除 `warnings` 外结果对象完全一致**（`bmr/tdee/缺口/标志位/macros/safetyMessages/etaWeeks` 全等）；推导 `warnings=[W_FLOOR_APPLIED]`、显式 `warnings=[W_WEEKLY_LOSS_AGGRESSIVE, W_FLOOR_APPLIED]`（仅输入侧告警差异） | ✅ 4/4 |
| B5 | **`W_TARGET_BMI_LOW`** | 165cm 目标 48kg（BMI 17.63 < 18.5）→ 触发；目标 55kg（BMI 20.20 ≥ 18.5）→ 不触发 | ✅ 2/2 |
| B6 | **`W_FLOOR_APPLIED` 为结果侧告警** | `floorApplied=false` 场景（男 30/180/85 运动员，周减 0.3）**无**该码；`validateCalorieInput`（纯校验）**绝不**产出该码 → 证明其由 `computeCalorieBudget` 计算后追加 | ✅ 3/3 |
| B7 | **TC-01 回归不倒退** | `1320 / 1584 / 550.0 / 475.3 / 1200 / true / true` 全部保持；`warnings` 仅 `[W_FLOOR_APPLIED]`；`safetyMessages` 2 条 | ✅ 9/9 |
| B8 | **`validateCalorieInput` 返回形态** | 返回 `{ errors: [], warnings: [] }` 两级对象；仅告警输入 `errors` 仍为空且 `calcCalorieBudget` 不抛错（**warnings 永不阻断**） | ✅ 5/5 |

### 10.3 C 项静态合规复检

| # | 核验项 | 方法 | 结果 |
| --- | --- | --- | --- |
| C1 | 禁用词扫描（`失败` / `超标` / `请反思` / `坚持就是胜利`） | `grep -rn` 于 `packages/core/src` **与** `apps/web/src` | ✅ **两处均零命中**。第 1 轮 P2（`validate.ts:24` 含「失败」）已改写为「热量引擎输入校验未通过（N 项）：…」→ **Q-02 关闭** |
| C2 | `packages/core/package.json` 无运行时依赖 | `JSON.parse` 检查 | ✅ **无 `dependencies` 键**（仅 devDependencies：vitest / coverage-v8 / typescript），零运行时依赖成立 |
| C3 | `packages/core/src/**` 无 IO / 时钟 | `grep -rn "Date.now(\|fetch(\|process.env"` | ✅ 唯一命中为 `daykey.ts:7` **注释文字**（说明"时间由参数注入"），非调用；无 `require(`、无 `node:` 导入、无 `fs.`、无 `localStorage` / `XMLHttpRequest` |
| C4 | **`ARCHITECTURE.md` §4.2 运算顺序未被动过** | 逐行核对 §4.2 的 1→13 步 vs `formulas.ts:86–129` | ✅ **13 步顺序逐条一致**：第 6 步 `MIN(rawDeficit, cap)` 先截断、第 9 步 `MAX(rawIntake, floor)` 后钳下限（下限优先级更高）。`formulas.ts` 仅新增「步骤 0）输入侧告警基线（**纯旁路**）」并在步骤 13 之后追加结果侧告警 —— **告警为纯旁路，1→13 运算顺序一字未改** |

### 10.4 D 项裁定（工程师提出的两个新问题 · 必答）

**问题 1 —— TC-02 fixture 把 `targetWeightKg` 由 48 改为 55 以隔离 `W_WEEKLY_LOSS_AGGRESSIVE`，是否可接受？**

> **判定：有效（可接受），责任人 NoOne（无需改动）。**

**理由**：
1. **PRD §8.1 TC-02 原文并未指定目标体重** —— 原文只写「女 30 岁 165cm 60kg，久坐，显式 `weeklyLossKg = 2`」，且其列出的预期字段（BMR/TDEE/缺口/cap/intake/标志位）**不含** `targetWeightKg` 或 `etaWeeks`。故取 55kg 不与 PRD 冲突。
2. **显式 `weeklyLossKg` 时，`targetWeightKg` 不参与缺口链路** —— 按 §4.2 步骤 3，`weeklyLoss = input.weeklyLossKg ?? derive(...)`；显式优先，故 `targetWeightKg` 仅影响 **步骤 13 的 `etaWeeks`** 与 **输入侧 `W_TARGET_BMI_LOW`**，对全部被断言字段**零影响**。我用独立脚本验证：显式链路（目标 55/48 均可）逐字段结果不变。
3. **契约要求「恰好 2 条告警」**。若保留目标 48kg（BMI 17.63 < 18.5），会**合法地**再触发 `W_TARGET_BMI_LOW` → 变 3 条，与 TC-02 的「恰好 2 条」断言矛盾。故隔离是**正确且必要**的 fixture 设计，而非"掩盖问题"。
4. `W_TARGET_BMI_LOW` 本身已在 `validate.test.ts`（48kg 触发 / 55kg 不触发）**独立覆盖**，隔离不影响该告警的测试完备性。

> **可选增强（P2 建议，非阻塞）**：可另加一条 **TC-02 变体**（`targetWeightKg = 48`）显式断言 `warnings = [W_WEEKLY_LOSS_AGGRESSIVE, W_TARGET_BMI_LOW, W_FLOOR_APPLIED]`（即 3 条），以覆盖**多告警叠加**路径。**责任人：QA（可选）。**

**问题 2 —— 主理人"TC-01 应同时含 2 条告警"是笔误，实际 TC-01 只触 `W_FLOOR_APPLIED` 1 条（另 2 条是 `safetyMessages`），此理解是否正确？**

> **判定：正确（有效），责任人 NoOne。**

**理由**：TC-01（女 30/165/60，目标 55，周减 0.5）：
- 输入侧：0.5 ≤ 60×2%=1.2 → 无 `W_WEEKLY_LOSS_AGGRESSIVE`；目标 55kg BMI 20.2 ≥ 18.5 → 无 `W_TARGET_BMI_LOW`；
- 结果侧：`floorApplied=true` → `W_FLOOR_APPLIED`。
- 故 **`warnings` = 1 条**；而 `safetyMessages` = **2 条**（floor 文案 + capped 文案，因 `isDeficitCapped` 亦为 true）。我的 B7 独立脚本实测：`warnings` 恰为 `[W_FLOOR_APPLIED]`、`safetyMessages.length === 2`，**工程师理解与源码行为一致**。

**`warnings` 与 `safetyMessages` 的语义分工**：

| 维度 | `warnings: ValidationWarning[]` | `safetyMessages: string[]` |
| --- | --- | --- |
| 性质 | **结构化通道**（含 `code`，可被 API/UI 判定、埋点、去重） | **直接渲染文案**（面向用户的成品字符串） |
| 语义层 | 输入侧告警（`W_WEEKLY_LOSS_AGGRESSIVE`、`W_TARGET_BMI_LOW`）+ 结果侧告警（`W_FLOOR_APPLIED`） | 仅由两个布尔标志位渲染（floor 文案 / capped 文案），**无 code** |
| 是否阻断 | **永不阻断**（`W_` 前缀，ARCHITECTURE §7 K3） | 不适用（是展示层输出） |
| 生成位置 | 输入侧由 `validateCalorieInput`；结果侧由 `computeCalorieBudget` 计算后追加 | `buildSafetyMessages({floorApplied, isDeficitCapped})` |
| 「缺口被 30% 上限截断」 | **不设告警码**（避免与 safetyMessages 重复） | 由 capped 文案承载（「为了更可持续…」） |
| 重叠处理 | 触下限时 `W_FLOOR_APPLIED` 与 floor 文案**语义重叠**，UI 应按 `code` **去重取一**（`CalorieCalculator.tsx:77–89` 已实现） | 同上 |

> 一句话：**`safetyMessages` 是"能直接贴到界面的句子"，`warnings` 是"带 code 的机器可读事件"**；同一条件的两种表达可并存，UI 去重，后端/埋点用 code。

### 10.5 遗留问题关闭状态（Q-01 ~ Q-06）

| ID | 第 1 轮严重度 | 描述 | **本轮关闭状态** | 证据 |
| --- | --- | --- | --- | --- |
| **Q-01** | P1 | PRD §8.1 TC-02 与 ARCHITECTURE §4.5 冲突（显式超限 `weeklyLossKg` 被硬拦截） | ✅ **已修复** | §4.5 重写为两级契约（`errors` 阻断 / `warnings` 不阻断）、新增 D13；PRD §8.1 TC-02 重写为"接受输入"；`validate.ts` 仅对非有限值/≤0 报 `E_WEEKLY_LOSS`；B1/B2/B3/B4 全绿 |
| **Q-02** | P2 | `CalorieInputError.message` 含禁用词「失败」 | ✅ **已修复** | `validate.ts:35` 改为「热量引擎输入校验未通过（N 项）：…」；C1 grep **零命中** |
| **Q-03** | P2 | PRD §8.1 TC-02 的 `cap` 写 474.9（应为 475.3） | ✅ **已修复** | PRD.md:384 已改为 `deficitCap = 475.3`；ARCH §4.4 与 D2 注明"以公式为准" |
| **Q-04** | P2 | `acceptance.test.ts` 变量 `tdeeFloat` 实为 BMR 浮点值 | ✅ **已修复** | `acceptance.test.ts:174` 已重命名 `bmrFloat` 并一致使用 |
| **Q-05** | P2 | `constants.ts` 的 `WEEKLY_LOSS_MAX_RATIO` 注释与硬错误实现不一致 | ✅ **已修复** | `constants.ts:54–60` 注释改为"不截断、不阻断计算，仅产出 `W_WEEKLY_LOSS_AGGRESSIVE`" |
| **Q-06** | P2 | `validate.ts:131` 分支未覆盖（branches 97.33%） | ✅ **已修复** | 新增「恰在体重 ×2% 以内不触发」用例；branches **88/88 = 100%** |

> **结论：Q-01 ~ Q-06 全部闭环。本轮遗留 P0 = 0，P1 = 0，P2 = 0。**

### 10.6 新增问题（本轮）

| ID | 严重度 | 描述 | 影响 | 建议 | 责任人 |
| --- | --- | --- | --- | --- | --- |
| **Q-07** | P2（可选增强） | TC-02 fixture 隔离了 `W_TARGET_BMI_LOW`，未覆盖「多告警叠加」路径 | 无功能风险；仅为测试完备性 | 可选新增 TC-02 变体（`targetWeightKg=48`）断言 3 条告警 | QA（可选） |

> **除上述可选增强外，本轮未发现新的 P0/P1/P2 缺陷。**

### 10.7 智能路由判定

> **Send To: NoOne**。工程师 T01-FIX 交付经我独立复跑**完全属实、无源码 Bug、无测试 Bug**；Q-01~Q-06 全部闭环；本轮遗留 P0 = 0、P1 = 0。唯一可选增强 Q-07（P2）不阻塞交付。

### 10.8 本轮临时产物（已清理）

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| `packages/core/test/_qa_round2.mjs` | QA 第 2 轮独立契约验证脚本（51 断言，手工期望） | ✅ 已删除 |
| `packages/core/test/_qa_bundle.mjs` | `esbuild` 打包 `src/index.ts` 的临时 ESM 模块（供上脚本 import 真实 API） | ✅ 已删除 |

> 本轮全部结论均来自**真实执行的命令输出**；工程师自述（64/64、覆盖率 100%、构建成功、TC-02 恰 2 条）仅作交叉比对，**逐项经我复跑核对为真**。
