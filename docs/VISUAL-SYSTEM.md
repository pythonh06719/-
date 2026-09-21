# 轻生活 · 视觉体系（Visual System）

> 本文是「视觉美术」的**规范表**（技术美术方法论里的资产预算表在 Web 侧的对应物）：
> 定义 elevation / 圆角 / 动效 / 焦点四张表，每项都给出**值 + 用途 + 深色模式差异**，
> 落地位置集中在 `tailwind.config.ts`（token）、`src/styles/index.css`（共用表面类）、
> `src/theme/dark.css`（深色覆盖）。
>
> 原则：**先有层级，再有外观**。改一个共用类，胜过改一百个页面里的写死的数值。

## 0. 为什么要有这套表

改前的实测状态（`apps/web`）：

| 维度 | 改前 | 问题 |
| --- | --- | --- |
| 阴影 | `shadow-sm` 22 处、`shadow-xl` 2 处、自定义 `soft` 1 处 | 没有层级，全是「同一个感觉」；`shadow-xl` 与「柔和」气质冲突 |
| 圆角 | 7 种混用（`rounded-xl` 89 / `rounded-2xl` 76 / `rounded-lg` 32 / `rounded-full` 19 / …） | 只有数值没有语义，同一个角色在不同页面长不一样 |
| 动效 | 1 个 keyframe，`duration-200 ease-out` 硬编码散落 | 时长与缓动各写各的，节奏不统一 |
| 深色 | 沿用浅色同款阴影（`rgba(31,41,55)`） | 深底上几乎不可见，深色模式没有层次感 |
| 焦点 | 共用表面类只有位移没有描边；全局规则还把圆角压成 6px | 键盘用户在部分位置看不到焦点；聚焦瞬间卡片「变形」 |

## 1. Elevation（阴影层级）

值定义在 `tailwind.config.ts → theme.extend.boxShadow`，具体数值写在 CSS 变量里：
浅色值在 `src/styles/index.css` 的 `:root`，深色值在 `src/theme/dark.css` 的 `html.dark`。
**变量化的原因**：同一个 utility（`shadow-qsh-2`）在两套主题里自动成立，调用点不必写 `dark:` 变体。

| Token | 用途 | 浅色值 | 深色值（差异） |
| --- | --- | --- | --- |
| `qsh-0` | 贴地 / 显式取消浮起 | `none` | 同 |
| `qsh-1` | **静止卡片**（默认表面） | `0 2px 10px -6px rgba(31,41,55,.10)` + `0 1px 3px -1px rgba(31,41,55,.06)` | `inset 0 1px 0 rgba(255,255,255,.04)` + `0 8px 24px -12px rgba(0,0,0,.6)` |
| `qsh-2` | **hover 浮起** / 悬浮层（下拉、气泡）；「主角」表面的静止态 | `0 12px 32px -12px rgba(31,41,55,.14)` + `0 4px 12px -6px rgba(31,41,55,.08)`（与原 `soft` 同值） | `inset 0 1px 0 rgba(255,255,255,.06)` + `0 14px 34px -14px rgba(0,0,0,.66)` |
| `qsh-3` | **弹窗 / 底部抽屉**；「主角」表面的 hover 态 | `0 24px 56px -16px rgba(31,41,55,.22)` + `0 8px 20px -10px rgba(31,41,55,.12)` | `inset 0 1px 0 rgba(255,255,255,.08)` + `0 26px 60px -18px rgba(0,0,0,.72)` |
| `soft` | **已弃用**，等价于 `qsh-2` | — | — |

深色模式的层级由三件事共同表达（缺一都会「看不见」）：

1. **更亮的表面色**：卡片 `#16241f` vs 基底 `#0f1a16`；
2. **顶部 1px 内高光**：模拟光源从上方来，给出厚度；
3. **少量但更深的真实阴影**：负责把卡片从背景里剥离。

> 为什么深色不直接把浅色阴影调暗：深底上的灰色投影照度差趋近于 0，调多少都糊。

## 2. 圆角（语义层级）

值定义在 `tailwind.config.ts → theme.extend.borderRadius`。
**命名的变化**：从「多大」（`xl` / `2xl` / `xl2`）改为「谁用」（`card` / `control` / `pill` / `sheet`），
这样同一个角色不会再在不同页面长出不同的角。

| Token | 值 | 用途 | 深色模式差异 |
| --- | --- | --- | --- |
| `radius-card` | 1rem（≈ 原 `rounded-2xl`） | 卡片表面：`.qsh-surface` / `.qsh-surface-warm` / 行动卡 | 无（几何不随主题变化） |
| `radius-control` | 0.75rem（≈ 原 `rounded-xl`） | 按钮、输入框、小型触发元素 | 无 |
| `radius-pill` | 9999px | 胶囊标签、Chip（`.qsh-chip`） | 无 |
| `radius-sheet` | 1.75rem（≈ 原 `xl2`/`3xl`） | 底部弹层 / 抽屉 | 无 |
| `3xl` / `xl2` | 1.5rem / 1.75rem | **历史值，保留但不再新增**：仍在底部弹层等处使用 | 无 |

收敛记录：`rounded-xl2` 原有 2 处（`.qsh-surface-warm`、首页骨架），二者都是**卡片**角色，
已收敛到 `radius-card`；骨架同步收敛是为了让加载态与真实表面同几何，避免数据到位那一刻「变形」。

## 3. 动效（时长 / 缓动）

| Token | 值 | 用途 |
| --- | --- | --- |
| `duration-qsh-fast` | 120ms | 微小反馈：按下、颜色切换、勾选状态变化 |
| `duration-qsh-base` | 200ms | 常规状态切换：hover 抬升、焦点出现（共用表面类默认值） |
| `duration-qsh-slow` | 320ms | 大块内容进出：骨架淡入、卡片级内容替换 |
| `ease-qsh-out` | `cubic-bezier(.22,.68,.28,1)` | **全站唯一缓动**，与加载屏叶片生长同源 → 语言统一 |

- 为什么只有三档时长：档位越多越难保持节奏一致；三档足够覆盖从「点击反馈」到「内容替换」。
- 为什么缓动与加载屏同源：首屏叶片动画是用户对产品的第一个动效印象，末端近水平的减速曲线
  （末端切线 P3−P2 ≈ 水平）让停得住、不弹跳，沿用同一曲线可让全站「同一种手感」。
- 无差异：深色模式不改变动效参数（只改颜色表现）。

## 4. Focus（焦点规范）

统一的几何 + 品牌色（`src/styles/index.css` 的共用类与 `src/theme/a11y.css` 的全局规则一致）：

| 项 | 值 | 说明 |
| --- | --- | --- |
| 宽度 | 2px | `focus-visible:outline-2` |
| 偏移 | 2px | `focus-visible:outline-offset-2`，与元素边界留出呼吸，不和描边黏在一起 |
| 样式 | solid | `focus-visible:outline`（显式声明，避免被 UA 默认 style 干扰） |
| 浅色 | `brand-500` `#2f9e78` | 重点大纲；若追求 ≥4.5:1 可用 `brand-600` `#248263`（4.72:1） |
| 深色 | `brand-300` `#8cc9ab` | 深底上必须提亮，与既有深色环同色 |
| 几何 | **不得改写 `border-radius`** | 旧规则把圆角压成 6px 会让卡片聚焦瞬间「变形」—— 环只描边，不改元素 |

覆盖范围：

- 全局：`theme/a11y.css` 的 `:where(a, button, input, select, textarea, [tabindex]):focus-visible`；
- 共用表面类：`.qsh-surface` / `.qsh-surface-warm` / `.qsh-action-card` 各自带上同一套环，
  并显式重申 `focus-visible:rounded-card`，保证卡片类的几何不被全局规则影响。

## 5. 落地映射（改哪个文件生效）

| 文件 | 负责 |
| --- | --- |
| `tailwind.config.ts` | token 定义（elevation / 圆角 / 时长 / 缓动） |
| `src/styles/index.css` | `:root` 的浅色 elevation 变量 + 三个共用表面类的 composition |
| `src/theme/dark.css` | `html.dark` 的深色 elevation 变量、卡片底色、深色焦点色 |
| `src/theme/a11y.css` | 全局焦点环几何与配色 |

新增界面时只需要：`className="qsh-surface rounded-card p-5"`（或直接用 `.qsh-surface`，
圆角已内建），阴影、过渡、焦点环自动继承；**不要再写** `shadow-* xl`、`rounded-*` 数值。
