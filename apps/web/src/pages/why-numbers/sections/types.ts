import type { WhySectionId } from '../why-sections';

/**
 * 26 条解释条目共用的组件入参。
 *
 * `id` / `title` **一律由 `why-sections.ts` 真源传入**（见 `sections/index.tsx` 的
 * `renderSection`），组件自己不抄一份标题 —— 这样「目录 ↔ 正文」的编号/标题漂移
 * 在结构上就不可能发生（曾经正是靠测试对拍才抓住的坑，现在从源头消除）。
 */
export interface WhySectionProps {
  /** 对应正文 `<h2 id="…">`，同时是目录锚点与滚动定位目标。 */
  readonly id: string;
  /** `<h2>` 的完整渲染原文，含编号字符（如 `① 热量预算怎么算`）。 */
  readonly title: string;
}

/** 「术语 → 数值」定义行的一条数据（`DerivationRow` 的纯数据形态）。 */
export interface DerivationRowData {
  readonly term: string;
  readonly value: string;
  readonly hint?: string;
}

/** 一条「为什么…」补充说明（正文里 `<dl>` 中 div 包裹的 dt/dd 对）。 */
export interface ReasonData {
  readonly title: React.ReactNode;
  readonly body: React.ReactNode;
}

/**
 * 结构统一的条目内容（④、⑥…㉖ 共 22 条）。
 *
 * 只有 ①②③⑤ 需要专用组件（表格 / 实时计算 / 卡片式补充说明），其余 22 条的页面结构完全一致：
 * 可选引导段 → 推导行 `<dl>` → 可选「为什么」`<dl>` → 可选结尾提示，故数据化。
 *
 * `id` 必须是 `WhySectionId` 联合里的字面量：注册表用它做 computed key，
 * 写错/漏登记在**编译期**就会报错（`Record<WhySectionId, …>` 的穷尽性检查）。
 */
export interface SimpleSectionContent {
  readonly id: WhySectionId;
  readonly intro?: React.ReactNode;
  /** 推导行；缺省时整段 `<dl>` 不渲染（如 ④ 只有「为什么」块）。 */
  readonly rows?: readonly DerivationRowData[];
  readonly reasons?: readonly ReasonData[];
  readonly note?: React.ReactNode;
}
