# 轻生活 · 视觉体系（Visual System）

> 本文是「视觉美术」的**规范表**（技术美术方法论里的资产预算表在 Web 侧的对应物）：
> 定义 elevation / 圆角 / 动效 / 焦点 / 字号 / 装饰六张表，每项都给出**值 + 用途 + 深色模式差异**，
> 落地位置集中在 `tailwind.config.ts`（token）、`src/styles/index.css`（共用表面类）、
> `src/theme/dark.css`（深色覆盖）、`src/components/common/BrandDecor.tsx`（装饰组件）。
>
> 原则：**先有层级，再有外观**。改一个共用类，胜过改一百个页面里的写死的数值。
> 另一条原则：**表面类不撒谎** —— 静态卡片不该带可点反馈，可点卡片才带（见 §7）。

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

统一的**几何**；品牌色按底色分档（表面类：浅色 `brand-600` / 深色 `brand-300`）：

| 项 | 值 | 说明 |
| --- | --- | --- |
| 宽度 | 2px | `focus-visible:outline-2` |
| 偏移 | 2px | `focus-visible:outline-offset-2`，与元素边界留出呼吸，不和描边黏在一起 |
| 样式 | solid | `focus-visible:outline`（显式声明，避免被 UA 默认 style 干扰） |
| 浅色 | `brand-600` `#248263` | 重点大纲：白底 **4.72:1**。旧值 `brand-500` `#2f9e78` 在白底只有 3.34:1，R3 加深一档 |
| 深色 | `brand-300` `#8cc9ab` | 深底上必须提亮，与既有深色环同色（R3 未变） |
| 几何 | **不得改写 `border-radius`** | 旧规则把圆角压成 6px 会让卡片聚焦瞬间「变形」—— 环只描边，不改元素 |

> 为什么浅色档要加深：`brand-500` 虽过 3:1 的非文本最低线（3.34:1），但卡片本身已有
> `ring-brand-100` 细描边，焦点环压在浅奶油/白底上时余量太小；`brand-600` 把余量拉到 4.72:1，
> 键盘用户一眼就能定位焦点。深色底上 `brand-300` 实测已达 AA，故不动。

覆盖范围：

- 全局：`theme/a11y.css` 的 `:where(a, button, input, select, textarea, [tabindex]):focus-visible`；
- 共用表面类：`.qsh-surface` / `.qsh-surface-warm` / `.qsh-action-card` 各自带上同一套环，
  并显式重申 `focus-visible:rounded-card`，保证卡片类的几何不被全局规则影响；
- `.qsh-surface-tappable` 是**修饰符**，焦点环由基类 `.qsh-surface` 提供，无需重复声明。

> ✅ **已解决（R4）**：浅色焦点环**全站收敛为单一色** `brand-600` `#248263`（对白底 4.72:1），
> 深色统一 `brand-300` `#8cc9ab`。共三处来源，缺一都会出现「两档环色」：
> ① 共享表面类 —— `styles/index.css` 的 `.qsh-surface` / `.qsh-surface-warm` / `.qsh-action-card`；
> ② 全局规则 —— `theme/a11y.css` 的 `:where(a, button, input, select, textarea, [tabindex]):focus-visible`；
> ③ **加载屏「跳过」按钮** —— `apps/web/index.html` 内联 `<style>` 的 `#qsh-skip:focus-visible`
>    （它必须早于任何 JS 渲染，规则只能内联在 HTML 里，是**唯一不在 CSS 文件中的焦点环**，收口时最易漏，
>    已一并改为 `#248263`；改的是 `<style>`，与 CSP 的**内联脚本** hash 无关，`check-csp-hash` 仍一致）。
> 实测（键盘 Tab 命中真实非表面控件）：浅色 `2px solid rgb(36,130,99)`（4.72:1）、
> 深色 `2px solid rgb(140,201,171)`（9.40:1），offset 均为 2px。

## 5. 字号层级（Typography）

值定义在 `tailwind.config.ts → theme.extend.fontSize`。**每档把字号、行高、字距绑在一起给**，
避免同一层级的文字在各页面各写各的 `leading-*`，节奏散掉。Tailwind 内置 `text-sm` 等保留，便于渐进迁移。

| Token | 字号 | 行高 / 字距 | 用途 | 深色差异 |
| --- | --- | --- | --- | --- |
| `text-display` | 1.75rem (28px) | 1.25 / -0.01em | 页面级大标题，一屏最多一个 | 无 |
| `text-title` | 1.25rem (20px) | 1.4 / -0.005em | 页头标题、卡片主标题 | 无 |
| `text-subtitle` | 0.9375rem (15px) | 1.5 | 空状态标题、小节标题 | 无 |
| `text-body` | 0.875rem (14px) | 1.6 | 正文、说明、列表 | 无 |
| `text-caption` | 0.75rem (12px) | 1.5 | 补充说明 | 无 |

> ⚠️ **对比度约束**：`text-caption`（12px）体量小、笔画细，**用于文字时必须确认前景 / 背景
> 对比度 ≥ 4.5:1**（WCAG AA 正文标准）。字号 token 只统一节奏，**不替你保证对比度** ——
> 这也是 `/why-numbers` 那批 12px 文字要从 `slate-500/400` 提到 `slate-600/300` 的原因。

## 6. 装饰（Decoration）

品牌装饰只有**一套造型**（五瓣花 + 茎叶），以三种载体出现；三者同源，**改形状要同步改**：

| 载体 | 落地位置 | 用途 |
| --- | --- | --- |
| 内联 SVG | `apps/web/index.html`（加载屏 logo） | 必须在脚本之前出现（首屏无 JS 时） |
| React 组件 `BrandDecor` | `src/components/common/BrandDecor.tsx` | 需要独立控制尺寸 / 颜色 / 摆位的场合 |
| CSS data-URI 背景 | `index.css` 的 `.qsh-surface-warm` + `dark.css` 同名覆盖 | 暖色卡片右下角那枚极淡小花 |

`BrandDecor` 的三个变体（`variant: 'corner' | 'leaf' | 'bloom'`）全部 `aria-hidden` +
`focusable="false"` + `pointer-events-none`，形状用 `currentColor` 继承文字色 ——
装饰**永不**进入无障碍树、**永不**拦截点击 / 焦点。

> **「两处一形」是刻意保留的**：组件版（`BrandDecor`）与内联版（`index.html` 加载屏）
> 画的是同一枚花，但没抽成单一来源 —— 内联 logo 必须在任何 JS 之前渲染，组件版要能被
> 独立复用到任意位置，抽公共源会让两者之一失去「独立最先出现 / 独立复用」的能力。
> **代价是改形状要同步 2~3 处**，故把这条约束写进 `BrandDecor.tsx` 顶部注释与本表，
> 作为**显式的技术债记录**（而非遗漏）。data-URI 花色只用既有色板（浅色 `warm-500`
> `#eaa032`、深色沿用 `#f8d9a0`），低透明度、贴右下角 28px，压不到正文。

## 7. 表面语义：静态 / 可点（`.qsh-surface` vs `.qsh-surface-tappable`）

R3 把「卡片表面」按**是否可点**拆开，让静态卡片不再假装可点：

| 类 | 语义 | 反馈 | 用在哪 |
| --- | --- | --- | --- |
| `.qsh-surface` | **静态表面** | 仅 elevation-1 静止 + 焦点环；**无** hover 抬升、**无** 按下缩放 | 不可点的容器：`div` / `section` / `form` / `fieldset` |
| `.qsh-surface` + `.qsh-surface-tappable` | **可点表面（中性）** | 悬停 → elevation-2，按下 → `scale(.995)`（仅在 `@media (hover: hover)`） | `<a>` / `<button>` / 带 `onClick` 或路由跳转的容器 |
| `.qsh-surface-warm` | **暖色主角表面** | elevation-2 静止；**无** hover 抬升、**无** 按下缩放（R4 起） | 首页问候 / 摘要 / 空状态 |
| `.qsh-action-card` | **品牌行动卡** | 悬停微抬 + 位移 + 变色，按下缩放 | 首页「记一餐 / 喝一杯水 / 动一动」 |

判定「可点」的唯一标准：元素是 `<a>` / `<button>`，或容器自身带 `onClick` / 路由跳转。
**不要**因为「它看起来像卡片」就叠 `qsh-surface-tappable`。

R3 现状：全仓 31 处 `.qsh-surface` 经逐个审计**全部为静态容器**，无一需要迁移；
真正可点的卡片早已使用 `.qsh-action-card`（3 处 `<Link>`）。故本轮**只拆不迁** ——
新修饰符就位，供后续新增的中性可点卡使用。

> ✅ **已解决（R4）**：`.qsh-surface-warm` 的 4 处用法经审计**全为静态容器**
> （判定依据同 R3：无 `onClick` / 无 `role="button"` / 无 `tabIndex` / 非 `<a>`·`<Link>` / 非路由容器），
> 故已**移除** `active:scale` 与 `hover→elevation-3` —— 消除「假可点」信号（静止维持 elevation-2）。
> 未新建 `-tappable` 变体（YAGNI：没有可点用法就不留空变体）。
> 顺带把它从 `prefers-reduced-motion` 的过渡名单里移除：本类已不再声明任何 `transition`，
> 对无动效的类设 `transition: none` 是死代码，会掩盖真实语义。
> **若将来出现可点的暖卡**，照 `.qsh-surface-tappable` 的方式加 `.qsh-surface-warm-tappable`，
> **不要**直接给基类加回 hover/active 反馈。

## 8. 落地映射（改哪个文件生效）

| 文件 | 负责 |
| --- | --- |
| `tailwind.config.ts` | token 定义（elevation / 圆角 / 时长 / 缓动 / 字号） |
| `src/styles/index.css` | `:root` 浅色 elevation 变量 + 表面类 composition（`qsh-surface` / `-tappable` / `-warm` / `qsh-action-card` + 暖卡装饰背景） |
| `src/theme/dark.css` | `html.dark` 深色 elevation 变量、卡片底色、深色焦点色、暖卡深色装饰 |
| `src/theme/a11y.css` | 全局焦点环几何与配色、触控目标、skip-link |
| `apps/web/index.html` | 加载屏 + 「跳过」按钮（内联 `<style>`，含其焦点环 `#qsh-skip`）；与 CSP 内联脚本 hash 绑定 |
| `src/components/common/BrandDecor.tsx` | 品牌装饰 SVG 三变体（`corner` / `leaf` / `bloom`） |
| `src/components/common/EmptyState.tsx` | 空状态（暖卡 + 花 + 一句话 + 可选动作） |

新增界面时只需要：`className="qsh-surface p-5"`（圆角已内建），阴影、过渡、焦点环自动继承；
**可点的**卡片再叠 `qsh-surface-tappable`；**不要再写** `shadow-xl`、`rounded-*` 数值。
