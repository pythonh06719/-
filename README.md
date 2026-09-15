# 轻生活（qingshenghuo）

> 移动端优先的生活化减肥工具 —— 不节食、不极端，把减肥融入日常生活。

本仓库为 **npm workspaces 单体仓库（monorepo）**，当前交付 **T01：可运行最小骨架 + 热量计算引擎 + 单元测试**。

## 目录结构

```text
qingshenghuo/
├─ packages/
│  └─ core/        # ★ @qsh/core：零 IO、零运行时依赖的纯函数引擎（前后端唯一真源）
└─ apps/
   └─ web/         # Vite + React 18 + TypeScript + Tailwind 的最小可运行壳（落地页 + 免注册计算器）
```

- `@qsh/core`：热量预算引擎（BMR/TDEE/缺口/安全下限/宏量营养素）、单位换算、本地日期工具。
  该包 **`dependencies` 为空**，不执行任何 IO、`fetch` 或 `Date.now()`，时间一律由参数注入。
- `apps/web`：落地页（产品介绍 + 隐私承诺 + 免责声明）内嵌 **免注册试用计算器**，全程零网络写请求。

## 环境要求

- Node.js ≥ 20（本项目在 node v22.22.2 上验证通过）
- npm 10+

## 安装

```bash
npm install
```

> 若直连 npm 官方源较慢，可在仓库根目录的 `.npmrc` 中使用镜像源（已默认配置 `https://registry.npmmirror.com`）。

## 运行测试（热量引擎，含覆盖率门禁 ≥ 90%）

```bash
npm test
# 等价于 npm run test -w @qsh/core
```

覆盖率阈值（lines / functions / branches / statements 均 ≥ 90%）作为门禁，任一不足即失败。

## 本地启动前端

```bash
npm run dev
# 打开终端提示的地址（默认 http://localhost:5173），在落地页完成一次免注册热量计算
```

## 构建前端

```bash
npm run build
```

## 类型检查（全仓）

```bash
npm run typecheck
```

## 引擎契约要点

- **运算顺序严格遵循** `PRD §5.2` / `ARCHITECTURE §4.2`：先截断缺口上限（TDEE × 30%），后钳制安全下限（女 1200 / 男 1500），**下限优先级高于上限**，两个标志位可同时为 `true`。
- **中间链路保留浮点，仅输出取整**（`ARCHITECTURE §4.4`）。
- 校验三种返回形态：`validateCalorieInput`（返回错误数组）、`calcCalorieBudget`（抛 `CalorieInputError`）、`safeCalcCalorieBudget`（返回判别联合、不抛错）。

## 免责声明

本产品不提供医疗建议。孕期 / 哺乳期 / 疾病治疗期人群不建议使用热量缺口方案，请咨询专业医师。
