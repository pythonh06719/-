/**
 * `/why-numbers` 的 26 条解释条目元数据（`pages/why-numbers/why-sections.ts`）。
 *
 * ## 为什么单独抽一个数组
 *
 * 目录导航要「按顺序列出这 26 条」，而正文里 26 个 `<section>` 是手写的 JSX。若目录另写一份
 * 条目表，两者必然漂移 —— 而**编号漂移正是本项目踩过的坑**（曾出现重复编号，用户在页面上
 * 找不到「第 20 条」到底说的是哪一条）。
 *
 * 所以这里把「编号 + 标题 + 锚点 id」定为**唯一真源**：
 *   - `title` 存的是 `<h2>` 的**完整渲染原文**（含 ① 这类编号字符）；
 *   - 目录从它切出编号（首字符）与短标题（去编号），不去正文里另抄一份；
 *   - 测试 `test/why-numbers-toc.test.tsx` 会把本数组与页面实际渲染出的 26 个 `<h2>`
 *     **逐条对拍**（id / 全文 / 顺序 / 编号连续唯一）。谁改了正文标题而没同步这里，用例转红。
 */

/** 一条解释条目。 */
export interface WhySection {
  /**
   * 对应正文 `<h2 id="…">`，同时是目录锚点与滚动定位目标。
   * 取值必须与 `WhyNumbersPage.tsx` 里的 h2 id 逐字相同（由测试对拍）。
   */
  readonly id: string;
  /** `<h2>` 的完整渲染原文，**含**开头的编号字符（如 `① 热量预算怎么算`）。 */
  readonly title: string;
}

/** 26 个带圈数字（① … ㉖），顺序即页面上的编号顺序。 */
export const CIRCLED_NUMERALS =
  '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖';

/** 全部 26 条，顺序 = 页面自上而下的顺序。 */
export const WHY_SECTIONS: readonly WhySection[] = [
  { id: 'why-budget-title', title: '① 热量预算怎么算' },
  { id: 'why-exercise-title', title: '② 运动消耗怎么算' },
  { id: 'why-data-title', title: '③ 数据来源与许可' },
  { id: 'why-choice-title', title: '④ 我们的取舍' },
  { id: 'why-goal-progress-title', title: '⑤ 目标进度与维持模式怎么判断' },
  { id: 'why-plateau-title', title: '⑥ 平台期是怎么判断的' },
  { id: 'why-weight-range-title', title: '⑦ 体重区间（近 7 / 30 / 90 天）怎么统计' },
  { id: 'why-weekly-title', title: '⑧ 周报里的对比与达成率怎么读' },
  { id: 'why-taper-title', title: '⑨ 快到目标时，为什么建议会自动变宽松' },
  { id: 'why-meal-order-title', title: '⑩ 餐次里的顺序是怎么定的' },
  { id: 'why-top-foods-title', title: '⑪ 常吃榜是怎么排出来的' },
  { id: 'why-backup-title', title: '⑫ 备份提醒与记录概览' },
  { id: 'why-period-title', title: '⑬「这段时间」里的六个数字怎么来' },
  { id: 'why-distinct-foods-title', title: '⑭ 不同食物的种类是怎么数出来的' },
  { id: 'why-wins-title', title: '⑮「体重之外的变化」这个数字怎么用' },
  { id: 'why-sfa-title', title: '⑯ 周报里的「饱和脂肪」是怎么来的' },
  { id: 'why-ai-usage-title', title: '⑰ AI 页面那个「还能问 N 次」是怎么算的' },
  { id: 'why-portion-title', title: '⑱ 改份量后，热量是怎么重算的' },
  { id: 'why-restore-title', title: '⑲ 备份恢复里的数字怎么来' },
  { id: 'why-tool-memory-title', title: '⑳ 生活化工具里的「我的常点」是怎么记住的' },
  { id: 'why-pending-sync-title', title: '㉑ 顶部那个「还有 N 笔在排队」是怎么来的' },
  { id: 'why-daily-avg-title', title: '㉒ 周报里两处「日均」用的是同一个分母' },
  { id: 'why-footprint-title', title: '㉓ 足迹日历里颜色的深浅是怎么定的' },
  { id: 'why-fasting-title', title: '㉔ 断食计时里的小时数怎么算' },
  { id: 'why-habit-streak-title', title: '㉕ 习惯的当前连续与历史最佳怎么算' },
  { id: 'why-water-progress-title', title: '㉖ 饮水目标与百分比怎么算' },
];

/** 条目的编号字符（`①` … `㉓`）—— 即标题的首字符。 */
export function sectionMarker(title: string): string {
  return title.slice(0, 1);
}

/** 去掉编号后的短标题，用于目录里把编号与标题分开排版（如 `⑳` + `生活化工具…`）。 */
export function sectionLabel(title: string): string {
  return title.slice(1).trimStart();
}

/**
 * 目录高亮：按各条标题相对「阅读线」的纵向位置，选出当前该高亮哪一条。
 *
 * ## 为什么不直接用 IntersectionObserver 的 isIntersecting
 *
 * 观察器只知道「进/没进视口」，不知道「用户正在读哪一条」——本页每张卡高度差很大
 * （有的 3 行、有的 40 行），视口里可能同时有 2~3 条处于 intersecting，选谁都不对。
 * 而用户真正的判断依据只有一条：**这一条的标题有没有越过阅读线（吸顶栏下沿）**。
 * 所以这里直接吃「各条标题的 viewport top」这一个一维信号，规则简单到可以纯函数单测。
 *
 * @param tops 各条标题 `getBoundingClientRect().top`（viewport 坐标，可为负）
 * @param readingLine 阅读线的 viewport y 坐标（吸顶目录条下沿 + 少量留白）
 * @returns 当前条目下标；页面还没滚到第一条时返回 0
 */
export function pickActiveIndex(tops: readonly number[], readingLine: number): number {
  let active = 0;
  for (let index = 0; index < tops.length; index += 1) {
    const top = tops[index];
    if (typeof top === 'number' && top <= readingLine) {
      active = index;
    } else {
      // tops 必须按文档顺序单调不减；一旦越线后面只会更靠下，可以停。
      break;
    }
  }
  return active;
}

/**
 * 校验 26 条编号**连续且唯一**（本项目历史上出过重复编号的坑，这里做成可测的纯函数）。
 *
 * @returns 问题描述数组；空数组代表通过。
 */
export function checkNumbering(sections: readonly WhySection[] = WHY_SECTIONS): string[] {
  const problems: string[] = [];
  if (sections.length !== 26) {
    problems.push(`条目数应为 26，实际 ${sections.length}`);
  }
  const seen = new Set<string>();
  sections.forEach((section, index) => {
    const marker = sectionMarker(section.title);
    if (CIRCLED_NUMERALS.indexOf(marker) === -1) {
      problems.push(`第 ${index + 1} 条编号「${marker}」不在 ①…㉖ 之内`);
    }
    if (seen.has(marker)) {
      problems.push(`编号重复：「${marker}」出现在第 ${index + 1} 条`);
    }
    seen.add(marker);
    if (CIRCLED_NUMERALS.indexOf(marker) !== index) {
      problems.push(`第 ${index + 1} 条编号应为「${CIRCLED_NUMERALS[index]}」，实际「${marker}」`);
    }
    if (seen.size !== index + 1) {
      problems.push(`锚点 id 重复：「${section.id}」`);
    }
  });
  return problems;
}
