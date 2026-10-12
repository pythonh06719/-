import { Fragment } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { WHY_SECTIONS } from './why-sections';
import { renderSection } from './sections';
import WhyNumbersToc from './WhyNumbersToc';

/**
 * 数字是怎么来的（`/why-numbers`，可解释性 / 透明度页）。
 *
 * 目的：把「这些数字是怎么算出来的」做成 App 内可查 —— 与「可溯源、无负罪感」定位一致。
 *
 * ⚠️ 早期版本是四个内容块（热量预算 / 运动消耗 / 数据来源 / 取舍），此后随功能上线陆续补到
 *    **26 条（①…㉖）**，这里已不再按「四块」组织，也**没有天然的分组层级** ——
 *    26 条是平铺的同级 `<section>`。目录导航因此做成平铺的编号横滑条，而不是吸顶分组标题。
 *    26 条的编号/标题/锚点清单是唯一真源，见同目录 `why-sections.ts`。
 *
 * ## 2026-10-12（P2-4）注册表化：本文件只剩「壳」
 *
 * 改造前这里是 1549 行手写 JSX（26 条全内联），加一条 = 在千行文件里插拔。
 * 现在：
 *   - **标题/锚点/顺序**：`why-sections.ts`（唯一真源，目录 `WhyNumbersToc` 同读）；
 *   - **逐条渲染**：`sections/index.tsx` 注册表（id → 渲染函数，编译期穷尽性检查）；
 *   - **条目内容**：①②③⑤ 走专用组件（表格 / 实时计算 / 卡片式补充说明），④、⑥…㉖ 走
 *     `sections/simple-sections.tsx` 的数据 + `sections/SimpleSection.tsx` 渲染器。
 *
 * 本文件因此只保留：页头、目录、按真源顺序渲染 26 条、页脚导航。
 * 「你的数字」实时计算随 ① 的消费方一起住在 `sections/BudgetSection.tsx`。
 *
 * **同源真源**：所有公式与活动系数均来自 `@qsh/core`（前后端唯一真源），
 * 页面用用户档案数据实时算出 BMR/TDEE 并展示分解（只读 `/profile` 接口，取数不可用时优雅降级为纯说明）。
 * 无障碍：语义化 section/h2 + dl/table；语气遵循 PRD §7（鼓励式、无负罪感）。
 */
export default function WhyNumbersPage(): ReactElement {
  return (
    <section aria-labelledby="why-numbers-title" className="space-y-5">
      <header className="space-y-1">
        <h1 id="why-numbers-title" className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          数字是怎么来的
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          这里的每一个数字都有出处。把「怎么算的」摊开讲清楚，你才好判断要不要信、要不要照着来。
        </p>
      </header>

      {/*
        目录导航：26 张卡，条目随功能增加后页面会继续变长，没有目录用户滚到靠后条目时不知道自己在哪。
        必须在 `<header>` 之后、正文之前 —— 目录要出现在首屏，且吸顶后不与 AppShell 顶栏重叠。
        放在 header 之前会让它先占掉首屏空间、并与 `aria-labelledby` 的标题顺序颠倒。
      */}
      <WhyNumbersToc />

      {/*
        26 条正文：顺序与 id/标题全部来自 why-sections.ts 真源，逐条查注册表渲染。
        Fragment 包一层是因为 renderSection 返回的是 <section> 本身、不方便带 key。
      */}
      {WHY_SECTIONS.map((section) => (
        <Fragment key={section.id}>{renderSection(section)}</Fragment>
      ))}

      {/* 页面间导航 */}
      <nav aria-label="相关页面" className="flex flex-wrap gap-3 text-sm">
        <Link
          to="/dashboard"
          className="qsh-touch-target inline-flex items-center font-medium text-brand-700 dark:text-brand-300"
        >
          ← 回到今天
        </Link>
        <Link
          to="/tools"
          className="qsh-touch-target inline-flex items-center font-medium text-brand-700 dark:text-brand-300"
        >
          去生活化工具看看 →
        </Link>
      </nav>
    </section>
  );
}
