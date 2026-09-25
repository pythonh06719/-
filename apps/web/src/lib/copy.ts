/**
 * 面向用户的文案集中管理（lib/copy.ts）。
 *
 * **硬性语气规范（PRD §7 K4）**：鼓励式、不贩卖焦虑、无负罪感。
 * 所有面向用户的固定文案集中在此，便于统一审校与替换；禁用词清单见 PRD §7.1。
 *
 * 命名约定：`COPY.xxx` 为常量，`xxxFor(...)` 为按参数生成的文案。
 */

import { PLATEAU_THRESHOLD_KG } from '@qsh/core';
import type { RecordOverviewKey } from '@qsh/shared-types';
import { WATER_ML_PER_CUP } from '@/theme/tokens';

export const COPY = {
  /** 通用鼓励（看板无数据 / 默认兜底） */
  defaultEncouragement: '今天也照顾好自己',
  /** 记录完成后的正向反馈 */
  mealLogged: '已经记下啦，谢谢你愿意花这几秒',
  /** 记录完成后的 announce（屏幕阅读器播报，TC-48） */
  mealLoggedAnnounce: '记录已添加，本餐热量已更新',
  /** 体重上涨时的中性说明（TC-34） */
  weightFluctuation: '波动很正常，看趋势就好',
  /**
   * 体重波动的日常原因（N3）。
   *
   * ⚠️ 这里**刻意不做数据因果归因**（不说「因为你昨天吃多了」）—— 那会把身体正常的起伏
   * 变成一种指责，直接违背「无负罪感」这条硬约束。这里只陈述**日常里本来就会让数字上浮的事**，
   * 不做因果推断，把判断权留给用户自己。
   */
  weightRiseTitle: '这几天体重往上走了一点',
  weightRiseLead: '数字往上走，多半是这几件日常小事叠在一起 —— 都不是做错了什么：',
  weightRiseReasonWater: '水分：喝水多少、出汗多少，身体都会临时调整',
  weightRiseReasonFood: '食物重量：吃下去的东西本身有重量，要一两天才走完',
  weightRiseReasonSalt: '盐分：吃得咸一点，身体会暂时多留一些水',
  weightRiseReasonSleep: '作息：睡得晚、累一点，第二天的数字也容易高一些',
  weightRiseClosing: '这些都是日常会有的上下浮动，不用特意改什么，也不用盯着某一天。',
  /**
   * 体重区间视图（C4）—— 让用户自己选看近 7 / 30 / 90 天。
   * 只是「把哪一段摊开看」，措辞中性、不评判、不催。
   */
  weightRangeLabel: '查看范围',
  weightRange7: '近 7 天',
  weightRange30: '近 30 天',
  weightRange90: '近 90 天',
  /** 区间统计小卡的中性标签（数值由纯函数算出，仅作陈述） */
  weightStatMin: '最低',
  weightStatMax: '最高',
  weightStatMean: '均值',
  weightStatChange: '净变化',
  /** 区间说明：把「当前在看哪一段」讲清楚，不催、不评判 */
  weightRangeOlderHint: '想看更早的记录，把上面的范围调大一点就好。',
  /** 选了较短区间、这一段内恰好没有记录时的中性引导（有历史、只是不在此区间） */
  weightRangeEmpty: '这个范围里还没有记录，换个更大的范围看看。',
  /**
   * 周报趋势增强（C2）—— 摄入 / 运动对比、习惯达成率、体重变化的中性解读。
   * 语气规范同 §7：只陈述事实、不做打分与催促，不使用红色 / 惩罚性语义。
   */
  reportTrendTitle: '摄入 vs 运动',
  reportTrendCaption: '每天的摄入与运动消耗，柱高用同一尺度，方便对比。',
  reportTrendEmpty: '这周还没有可对比的数据，记几笔就会显示。',
  reportIntakeSeries: '摄入',
  reportExerciseSeries: '运动',
  reportHabitTitle: '习惯达成率',
  reportHabitEmpty: '还没有设置习惯，加了之后这里会显示一周的达成情况。',
  reportHabitNote: '打卡是给自己留的记号，做到多少都算数。',
  /** 体重变化的三种中性解读（不评判方向，只把事实说清楚） */
  reportWeightMissing: '这周体重记录还不够，等有两条以上再一起看趋势。',
  reportWeightFlat: '这周体重基本持平，稳住节奏就好。',
  reportWeightDown: '这周体重略有下降，按自己的节奏来就好。',
  reportWeightUp: '这周体重略有上浮，波动很正常，看趋势就好。',
  /** 目标进度卡（R2.7）——标题 / 维持模式 / 注脚；措辞中性，不做打分与催促 */
  goalProgressTitle: '距离目标',
  goalProgressRingLabel: '目标进度',
  goalProgressReachedTitle: '已经到啦',
  goalProgressReachedBody: '已经到啦，接下来把节奏稳住就好',
  goalProgressFootnote: '进度只是帮你看清走到哪儿了，不是给自己的打分',
  /** 平台期说明卡（R2.7）——解释「为什么」，不使用红色 / 恐吓语义，也不指责 */
  plateauTitle: '这几周体重没怎么动',
  plateauBody:
    '这不是停滞，是身体在适应。每天的数字本来就会被水分、食物重量、作息推着上下浮动 —— 连着几周不动很常见，不代表之前的记录白做了。',
  plateauFootnote:
    '我们不会因为几周不动就建议你加大缺口 —— 比起再压一点，把节奏稳住更容易走得远。',
  /**
   * 平台期卡的收起动作（AC-11.1.6，展示频控）——**温和措辞**：
   * 不用「关闭 / 忽略 / 不再显示」这类生硬字眼，把它讲成「先收起来，这一周先不打扰你」。
   */
  plateauDismiss: '好，先收起来',
  plateauDismissAria: '好，先收起来：收起后这一周就不打扰你了',
  /** 长时间未记录后的温和召回（TC-35 / US-17） */
  streakReturn: '休息一下没关系，随时回来',
  /** 连续记录的正向表述（弱化「不能断」的压迫感） */
  streakPositive: '保持记录很不容易，偶尔休息也没关系',
  /** 数据为空时的引导 */
  emptyDiary: '今天还没有记录，点一下就好',
  emptyWeight: '记录第一笔体重，之后就交给趋势吧',
  /** 问候卡（首页生活流）的空状态——三处空态各归各位，互不重复 */
  emptyToday: '今天还没记，从一杯水开始也行',
  /** 首页摘要卡（数据卡）的空状态 */
  emptyTodayData: '今天还没记，随手来一笔就好',
  /** 首页摘要卡空态主行（动作导向：给一个下一步，避免与问候卡的「今天还没记」重复） */
  emptyTodayAction: '记一笔，今天就有数了',
  /** 日记页整日无记录的空状态（吃饭语境） */
  emptyTodayDiary: '今天还没记，从一顿早餐开始也行',
  /** 摘要卡：无参考预算时的中性主行 */
  noBudgetSummary: '记好今天的三餐就好',
  /** 离线 / 后端未就绪时的友好说明 */
  offlineNotice: '网络好像不太稳定，先看看已经缓存的内容吧',
  offlineQueued: '已保存在本地，联网后会自动同步',
  /** 引导问卷中的安全提示（US-20 / TC-38） */
  riskyGroupNotice:
    '本产品不适合孕期、哺乳期或正处于疾病治疗期的朋友。如果你属于其中任何一类，建议先咨询专业医师，我们不建议在此时使用热量缺口方案。',
  /** 免责声明（US-04 / R1.5） */
  disclaimer:
    '本产品不提供医疗建议，也不能替代专业诊断与治疗。计算结果仅用于健康生活参考。',
  /** 快速加卡的提示 */
  quickAddHint: '搜不到也没关系，填名称和热量就能记下来',
  /** 运动 / 饮水（二期） */
  movementLogged: '记上啦，这一步都算数',
  waterGentle: '喝多少看身体的感觉，不用凑数',
  /** 习惯打卡（二期） */
  habitChecked: '打卡成功，慢慢来就好',
  habitUnchecked: '已取消今日打卡',
  /**
   * 习惯「连续日历」（C3）—— 只陈述「哪天打了卡」，**不评判断签**：
   * 断签渲染成空心格，绝不出现红叉 / 「已断 N 天」/ 任何惩罚性表述。
   */
  habitCalendarTitle: '最近 35 天',
  habitCalendarHint: '实心是打过卡的日子，空心只是那天没记 —— 歇一歇也很正常',
  habitCalendarEmpty: '还没有打卡记录，从今天开始就很好',
  /** 断食（二期）——不做怂恿，随时可以停（R8.3） */
  fastingReminder: '断食适合与否因人而异，随时可以停下来',
  fastingWarningTitle: '开始前，想先和你说清楚几件事',
  /** AI 助手（三期，R9.x）——语气同 §7：温和、不评判、不贩卖焦虑 */
  aiUnavailable: 'AI 助手暂不可用，先看看基于你的记录整理的内容吧',
  aiRuleModeNote: '以下内容基于你的记录整理，仅供参考，不构成医疗建议',
  aiDailyTab: '每日总结',
  aiPlanTab: '今日方案',
  aiAskTab: '自由提问',
  aiRecognizeTitle: '描述识别食物',
  aiRecognizeHint: '描述一下吃了什么，我来帮你找找相近的食物',
  aiRecognizeEmpty: '没有找到相近的食物，可以换个说法，或在饮食日记里手动记一笔',
  aiRecognizeConfirm: '确认记录',
  aiRecognizeConfirmed: '已经记下啦，可以在饮食日记里看到',
  aiDailyGenerate: '生成今日复盘',
  aiPlanGenerate: '生成今日方案',
  aiAskPlaceholder: '比如：今天还能吃一个苹果吗',
  aiAskSend: '问一问',
  aiAskEmpty: '想问点什么都可以，先写一句吧',
  /** 数据备份（C6）—— 把「留一份备份」说成一件随手的小事：不催促、不吓唬、不制造焦虑 */
  dataBackupTitle: '留一份备份',
  dataBackupDesc:
    '把现在的记录打包成一个文件，存到自己的电脑里。什么时候想留一份都可以，不留也没关系。',
  dataBackupButton: '导出备份',
  dataBackupRunning: '正在整理你的备份…',
  dataBackupDone: '已经备份好啦，文件就在下载里，收好就行',
  dataBackupFailed: '这次没有整理成功，晚一点再试就好',
  dataBackupNever: '还没有备份过，什么时候想留一份都可以',
  dataBackupToday: '上次备份就是今天',
  /**
   * 餐次排序（R3.8）—— 拖拽只是「把顺序理一理」，措辞不能变成任务或评价。
   */
  reorderGuide: '按住条目可以拖动，也能把它拖到别的餐',
  reorderGuideAriaClose: '不再显示这条拖动说明',
  /** 移动成功：`已经放到午餐了`（主语是这条记录，不是「你做对了」） */
  reorderMovedPrefix: '已经放到',
  reorderMovedSuffix: '了',
  /** 离线 / 失败：**中性陈述**，不以「失败」作标题、不用红色（AC-3.8.9） */
  reorderFailed: '这次没有移动成功，稍后再试试',
  /** 常吃榜（R11.5）—— 只呈现频次，零营养评判（AC-11.5.3 / AC-11.5.4） */
  topFoodsTab: '常吃',
  topFoodsTitle: '你常吃的',
  /** 记录概览（R11.6）—— 只陈述事实，不做任何「异常 / 离群」判定（AC-11.6.7） */
  dataOverviewTitle: '记录概览',
  dataOverviewDesc: '这里列出你已经记下了多少、跨度多久。只做陈述，不评判任何一条记录。',
  dataOverviewEmpty: '还没有记录，什么时候想记都可以。',
  /**
   * 阶段回顾（R11.3）—— 指标全部是**独立陈述句**（AC-11.3.2 白名单 / AC-11.3.3 黑名单）。
   *
   * ⚠️ 红线：不出现「完成度 / 达成率 / 连续 / 断签 / 缺失」；记录天数**没有分母**，
   * 不写「48/365 天」或百分比；体重只说方向与差值，**后面不接任何判断句**（QR-4）。
   * 所有数字句一律由下方 `period*Line()` 函数生成，组件里不允许内联拼数字。
   */
  reportTabWeekly: '本周',
  reportTabPeriod: '这段时间',
  periodDayOptionPrefix: '近',
  periodDayOptionSuffix: '天',
  periodEmpty: '这段时间还没有记录，什么时候想起来都可以开始',
  periodTopTitle: '这段时间吃得最多的是',
  periodWinTitle: '体重之外的变化',
  /** 周报多样性行（R11.7）—— 只计数，不打分（AC-11.7.3） */
  diversityExpand: '看看到底有哪些',
  diversityCollapse: '先收起来',
  diversityListTitle: '这周吃过的',
  diversityTruncated: '已经很多啦，先显示这些',
  /** 「体重之外的变化」（R11.4）—— 零压力入口（AC-11.4.1） */
  winCardTitle: '体重之外的变化',
  winCardDesc: '有些变化秤称不出来，但你自己知道',
  winCardPlaceholder: '比如：今天爬楼没那么喘了 / 裤子松了一圈',
  winCardInputLabel: '记一条体重之外的变化',
  winCardSubmit: '记下来',
  winCardSaved: '记下啦，回头看的时候会很开心',
  winCardOfflineSaved: '已经记下啦（还没同步）',
  winCardDeleted: '已经删掉了',
  winCardTooLong: '最多能写 60 个字',
  /** 删除未成功（业务错误）：中性陈述，不用「失败 / 错误」等词（PRD §7 语气规范） */
  winCardDeleteFailed: '这条这次没有删掉，稍后再试试',
  winCardListTitle: '回头看',
  winCardListEmpty: '还没有记过，想起来就写一句',
  /** 列表读取失败：**不得**复用空态文案「还没有记过」（会把「读不到」误说成「没记过」） */
  winCardListError: '暂时读不到，稍后再看看',
  /** 每日轻提醒（R5 附加，本轮仅本地通知，不做服务端推送） */
  reminderToggleTitle: '每日轻提醒',
  reminderToggleDesc: '应用打开时，一天一条温和的提醒。默认关闭，随时可以停用',
  reminderGranted: '好啦，明天见',
  reminderDenied: '通知权限没有打开，想开的时候再来这里就好',
  reminderUnsupported: '这台设备暂时不支持通知，不影响其他功能',
} as const;

/** 记录完成后带热量的反馈文案。 */
export function mealLoggedWithKcal(kcal: number): string {
  return `已经记下啦，这一餐约 ${Math.round(kcal)} kcal`;
}

/** 距上次记录的温和提示（不指责，仅在用户进入时展示）。 */
export function welcomeBack(daysSinceLastLog: number): string {
  if (daysSinceLastLog <= 1) {
    return COPY.defaultEncouragement;
  }
  return COPY.streakReturn;
}

/** 饮水进度文案（不设惩罚）。 */
export function waterProgress(currentMl: number, goalMl: number): string {
  if (goalMl <= 0) {
    return `今天喝了 ${Math.round(currentMl)} ml`;
  }
  if (currentMl >= goalMl) {
    return '今天的水已经喝够啦，做得很好';
  }
  return `今天已经喝了 ${Math.round(currentMl)} ml，慢慢来`;
}

/** 剩余热量文案（超出时中性表达，不做恐吓，PRD §7）。 */
export function remainingLabel(remainingKcal: number): string {
  if (remainingKcal < 0) {
    return '今天吃得丰富一些，明天照常就好';
  }
  return '今天还可以这样安排';
}

// ---------------------------------------------------------------------------
// 目标进度 / 维持模式（R2.7）
// 语气规范同 §7：只陈述事实与下一步，**不催促、不打分、不在维持模式制造缺口**。
// ---------------------------------------------------------------------------

/** 一位小数（本地不依赖千分位，避免 `toLocaleString` 在部分环境下的差异）。 */
function oneDecimal(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

/** 「距离目标还有 X kg」。 */
export function goalRemainingLine(remainingKg: number): string {
  return `距离目标还有 ${oneDecimal(remainingKg)} kg`;
}

/**
 * 「按当前节奏还需 X 周」。
 *
 * 向上取整并保证至少 1 周 —— 说「还需 0 周」会让人以为已经到了，说「还需 3.2 周」太像报表。
 */
export function goalEtaLine(etaWeeks: number): string {
  const weeks = Math.max(1, Math.ceil(etaWeeks));
  return `按当前节奏还需 ${weeks} 周`;
}

/** 无法给出 ETA（如缺口为 0）时的兜底：只说目标，不编造周数。 */
export function goalTargetLine(targetWeightKg: number): string {
  return `目标 ${oneDecimal(targetWeightKg)} kg，按自己的节奏来`;
}

/** 进度基准说明（可解释性：让用户知道百分比是怎么算出来的）。 */
export function goalBaselineLine(baselineKg: number, targetWeightKg: number): string {
  return `从 ${oneDecimal(baselineKg)} kg 出发，目标 ${oneDecimal(targetWeightKg)} kg`;
}

/**
 * 维持模式下的热量说明（= TDEE，不制造缺口）。
 *
 * ⚠️ 绝不可写成「继续减」「再压一点」—— 已达成目标时再制造缺口是错误引导。
 */
export function maintenanceLine(maintenanceKcal: number): string {
  return `维持热量约 ${Math.round(maintenanceKcal)} kcal/日，不用再往下压`;
}

// ---------------------------------------------------------------------------
// 平台期（R2.7）
// 语气规范同 §7：只解释原因 + 给一个新的观察视角，**不指责、不建议加大缺口、不用红色**。
// ---------------------------------------------------------------------------

/** 「最近 X 天，7 日均线的变化不到 0.3 kg」—— 把判定依据直接摊开讲。 */
export function plateauStalledLine(stalledDays: number): string {
  return `最近 ${Math.round(stalledDays)} 天，7 日均线的变化不到 ${PLATEAU_THRESHOLD_KG} kg`;
}

/** 把视角从「每天」拉到「4 周」：给斜率，不给评价。 */
export function plateauSlopeLine(kgPerWeek: number): string {
  const sign = kgPerWeek > 0 ? '+' : '';
  return `把时间拉到 4 周看，平均每周 ${sign}${kgPerWeek.toFixed(2)} kg`;
}

/** 斜率的中性解读（三个方向都不带褒贬：往下走 / 持平 / 略微上浮都是正常的事）。 */
export function plateauSlopeHint(kgPerWeek: number): string {
  if (kgPerWeek <= -0.05) {
    return '拉长看，趋势其实还在往下走。';
  }
  if (kgPerWeek >= 0.05) {
    return '拉长看，这几周略微上浮，波动很正常。';
  }
  return '拉长看，这几周基本持平。';
}

// ---------------------------------------------------------------------------
// 习惯连续日历（C3）
// 语气规范同 §7：把日历当「一起走过的日子」的旁观记录，**不催、不评断签**。
// ---------------------------------------------------------------------------

/**
 * 连续日历的无障碍标签。
 *
 * 只播报「有几天打了卡」这一事实，**不播报「断了几天」**（避免把留白读成缺失）。
 *
 * @param checkedDays 窗口内已打卡天数（0 ~ 35）
 */
export function habitCalendarAria(checkedDays: number): string {
  const days = Number.isFinite(checkedDays) ? Math.max(0, Math.floor(checkedDays)) : 0;
  return `最近 35 天里，有 ${days} 天打过卡`;
}

// ---------------------------------------------------------------------------
// 体重区间视图（C4）
// 语气规范同 §7：区间只是「把哪一段摊开看」，数字如实陈述，不做评判、不催。
// ---------------------------------------------------------------------------

/** 区间标签（「近 N 天」）；未知天数兜底为「近 N 天」，不抛错。 */
export function weightRangeName(days: number): string {
  if (days === 7) return COPY.weightRange7;
  if (days === 30) return COPY.weightRange30;
  if (days === 90) return COPY.weightRange90;
  const safe = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 1;
  return `近 ${safe} 天`;
}

/**
 * 区间说明句：当前范围、记录笔数、起始日期。
 *
 * 例：`当前查看近 30 天：共 12 笔记录，起始于 2026年9月1日。`
 * 无记录时不带「起始于」从句（避免出现空日期）。
 */
export function weightRangeCaption(days: number, count: number, sinceLabel: string | null): string {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const head = `当前查看${weightRangeName(days)}：共 ${safeCount} 笔记录`;
  return sinceLabel === null ? `${head}。` : `${head}，起始于 ${sinceLabel}。`;
}

// ---------------------------------------------------------------------------
// 周报趋势增强（C2）
// 语气规范同 §7：习惯达成率与体重变化都只做中性陈述，不评判、不催。
// ---------------------------------------------------------------------------

/**
 * 习惯达成率文案。
 *
 * @param doneTimes 一周内累计打卡次数（同一习惯同一天记一次）
 * @param ratePercent 达成率百分比（0 ~ 100）
 */
export function reportHabitRateLabel(doneTimes: number, ratePercent: number): string {
  const times = Number.isFinite(doneTimes) ? Math.max(0, Math.floor(doneTimes)) : 0;
  const percent = Number.isFinite(ratePercent) ? Math.min(100, Math.max(0, Math.round(ratePercent))) : 0;
  return `本周共打卡 ${times} 次，达成率 ${percent}%`;
}

/**
 * 体重变化的中性解读（无负罪感）。
 *
 * - `null` / 非有限值 → 记录不足，先不谈趋势；
 * - `|Δ| ≤ 0.1` → 基本持平；
 * - 明显下降 / 上浮 → 各自的温和说法（上浮沿用 `weightFluctuation` 的口径）。
 */
export function weeklyWeightReading(changeKg: number | null): string {
  if (changeKg === null || !Number.isFinite(changeKg)) {
    return COPY.reportWeightMissing;
  }
  if (changeKg > 0.1) {
    return COPY.reportWeightUp;
  }
  if (changeKg < -0.1) {
    return COPY.reportWeightDown;
  }
  return COPY.reportWeightFlat;
}

/** 摄入 / 运动对比图的无障碍标签（含七天合计，让读屏用户也拿到对比结论）。 */
export function reportTrendAria(intakeTotalKcal: number, exerciseTotalKcal: number): string {
  const intake = Number.isFinite(intakeTotalKcal) ? Math.round(intakeTotalKcal) : 0;
  const exercise = Number.isFinite(exerciseTotalKcal) ? Math.round(exerciseTotalKcal) : 0;
  return `近 7 天摄入与运动消耗对比，共摄入 ${intake} 千卡，运动消耗 ${exercise} 千卡`;
}

// ---------------------------------------------------------------------------
// 数据备份（C6）
// 语气规范同 §7：把「上次备份于 X 天前」当作一句中性的事实陈述，**不暗示「该备份了」**。
// ---------------------------------------------------------------------------

/**
 * 「上次备份于 X 天前」。
 *
 * - 从未备份 / 时间戳无法解析 → 中性引导语（`dataBackupNever`），不说「你还没备份」式提醒；
 * - 今天备份过 → 「上次备份就是今天」；
 * - 其余 → 「上次备份于 X 天前」（天数向下取整、不为负）。
 */
export function lastBackupLabel(daysSince: number | null): string {
  if (daysSince === null || !Number.isFinite(daysSince)) {
    return COPY.dataBackupNever;
  }
  const days = Math.max(0, Math.floor(daysSince));
  if (days <= 0) {
    return COPY.dataBackupToday;
  }
  return `上次备份于 ${days} 天前`;
}

/**
 * ≥ 30 天未备份的**温和提示**（R11.6 / AC-11.6.2）。
 *
 * ⚠️ 与 {@link lastBackupLabel} **并存、不合并**：`lastBackupLabel` 是事实陈述（C6 基座，
 * 回归保护项，只增不删），本函数是**额外**的一行提示。< 30 天返回 `null`（不渲染），
 * 避免把「提示」变成日常噪音。
 *
 * 语气红线（AC-11.6.4 / AC-11.6.5）：
 * - 主语是「距离上次备份」，**不是**「你已经 N 天没备份」（不把天数写成欠账）；
 * - 以「什么时候方便」「不留也没关系」这类**非指令性**短语收尾；
 * - 禁用词（危险 / 丢失 / 风险 / 即将 / 务必 / 一定 / 立刻 / 现在就 / 紧急 / 警告 / 失效 / 备份以待万一）一个都不出现。
 *
 * @param days 距上次备份的天数；`null` / 非有限值（从未备份）→ `null`
 * @returns 提示文案；不需要提示时 `null`
 */
export function backupHintCopy(days: number | null): string | null {
  if (days === null || !Number.isFinite(days)) {
    return null; // 从未备份：沿用 dataBackupNever（lastBackupLabel 已覆盖）
  }
  const d = Math.max(0, Math.floor(days));
  if (d < 30) return null;
  if (d < 90) return `距离上次备份有 ${d} 天了。数据都还在账号里，什么时候方便再留一份就行`;
  return `距离上次备份 ${d} 天了。随时可以再留一份，不留也没关系`;
}

// ---------------------------------------------------------------------------
// 餐次排序（R3.8）
// 语气规范同 §7：只说「这条记录被放到哪儿了」，不评价、不催促、不用失败/错误作标题。
// ---------------------------------------------------------------------------

/** 「把「番茄炒蛋」上移」——降级控件的完整无障碍标签（AC-3.8.7）。 */
export function mealMoveUpAria(name: string): string {
  return `把「${name}」上移`;
}

/** 「把「番茄炒蛋」下移」。 */
export function mealMoveDownAria(name: string): string {
  return `把「${name}」下移`;
}

/**
 * 「把「番茄炒蛋」移动到午餐」——跨餐移动的完整无障碍标签（AC-3.8.7）。
 *
 * @param name 食物名称
 * @param mealLabel 目标餐次中文名（早/午/晚餐、加餐）
 */
export function mealMoveToAria(name: string, mealLabel: string): string {
  return `把「${name}」移动到${mealLabel}`;
}

/** 「把「番茄炒蛋」移动到另一餐」——`<select>` 本身的标签。 */
export function mealMoveSelectAria(name: string): string {
  return `把「${name}」移动到另一餐`;
}

/** 移动成功播报：`已经放到午餐了`。 */
export function mealMovedLine(mealLabel: string): string {
  return `${COPY.reorderMovedPrefix}${mealLabel}${COPY.reorderMovedSuffix}`;
}

// ---------------------------------------------------------------------------
// 常吃榜（R11.5）
// 语气规范同 §7 + 约束 4：**只呈现频次**，禁止任何营养评判（AC-11.5.3 / AC-11.5.4）。
// ---------------------------------------------------------------------------

/**
 * 「12 天」——**只给天数这一个数字**，不标热量、不标营养素、不给等级（AC-11.5.3）。
 */
export function topFoodDaysLabel(dayCount: number): string {
  const days = Number.isFinite(dayCount) ? Math.max(0, Math.floor(dayCount)) : 0;
  return `${days} 天`;
}

/**
 * 「近 90 天里，米饭出现了 12 天」——**一句事实陈述**，不是一句评语。
 *
 * ⚠️ 绝不可改写成「你摄入了过多糖分」「建议少喝」这类句式（PRD §7 反例）。
 */
export function topFoodsAria(name: string, dayCount: number, days: number): string {
  const window = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 90;
  const count = Number.isFinite(dayCount) ? Math.max(0, Math.floor(dayCount)) : 0;
  return `近 ${window} 天里，${name}出现了 ${count} 天`;
}

// ---------------------------------------------------------------------------
// 记录概览（R11.6）
// 语气规范同 §7：只陈述「有几条、跨度多久」这一事实，
// **不做任何异常 / 离群值判定**（AC-11.6.7 —— 「异常」本身即评判）。
// ---------------------------------------------------------------------------

/** 概览各行的中性标签。 */
export const OVERVIEW_KEY_LABELS: Readonly<Record<RecordOverviewKey, string>> = {
  weights: '体重',
  meals: '餐次条目',
  exercises: '运动',
  habits: '习惯打卡',
  water: '饮水',
  wins: '体重之外的变化',
};

/**
 * 「128 条，从 5月2日 到今天」——概览行的**右半段**（不含标签）。
 *
 * ⚠️ **刻意不带标签**：概览卡用 `<dl>` 渲染，`<dt>` 已经是标签本身；
 * 若把整句再塞进 `<dd>`，读屏会读成「体重 / 体重 128 条…」的重复。
 * 拆成「左标签（`<dt>`）+ 右事实（`<dd>`）」两半，既符合 `dl` 语义，也不重复朗读。
 *
 * - `count = 0` → 调用方**整行隐藏**（不显示 0，避免被读成一种成绩）；
 * - 只有一天记录 → 「就在 5月2日」，不编造跨度；
 * - 日期缺失 → 只说条数。
 */
export function dataOverviewDetail(
  count: number,
  firstDate: string | null,
  lastDate: string | null,
  format: (dateKey: string) => string,
): string {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (firstDate === null || lastDate === null) {
    return `${safeCount} 条`;
  }
  if (firstDate === lastDate) {
    return `${safeCount} 条，就在 ${format(firstDate)}`;
  }
  return `${safeCount} 条，从 ${format(firstDate)} 到 ${format(lastDate)}`;
}

// ---------------------------------------------------------------------------
// 生活化文案（homepage「今天」的生活流：问候 / 叙事 / 分档鼓励 / 水杯换算）
// 语气规范（PRD §7 K4）：说人话、不评判、无负罪感；禁用词见 §7.1。
// ---------------------------------------------------------------------------

/** 一杯水的容量（ml）——用于把毫升换算成「第几杯」（与设计令牌同源）。 */
const ML_PER_CUP = WATER_ML_PER_CUP;

/**
 * 按本地时间给出时段问候。
 *
 * @param hour 本地小时（0–23）
 * @returns 「早上好 / 中午好 / 下午好 / 晚上好」
 */
export function greetingForHour(hour: number): string {
  if (!Number.isFinite(hour)) {
    return '你好';
  }
  const normalized = ((Math.floor(hour) % 24) + 24) % 24;
  if (normalized >= 5 && normalized < 11) {
    return '早上好';
  }
  if (normalized >= 11 && normalized < 14) {
    return '中午好';
  }
  if (normalized >= 14 && normalized < 18) {
    return '下午好';
  }
  return '晚上好';
}

/**
 * 首页一句生活叙事——根据「今天记了几笔 / 有没有吃」说人话。
 *
 * @param input.mealCount 今天已记录的食物笔数（可为 0）
 * @param input.intakeKcal 今天已摄入热量（kcal）
 * @returns 一句日常口吻的状态描述
 */
export function lifeNarrative(input: { mealCount: number; intakeKcal: number }): string {
  const meals = Number.isFinite(input.mealCount) ? Math.max(0, Math.floor(input.mealCount)) : 0;
  if (meals >= 3) {
    return `今天记了 ${meals} 笔，挺顺的`;
  }
  if (meals >= 1) {
    return `今天记了 ${meals} 笔，慢慢来`;
  }
  if (Number.isFinite(input.intakeKcal) && input.intakeKcal > 0) {
    return '今天已经记下一些了';
  }
  return COPY.emptyToday;
}

/**
 * 首页摘要卡里的一句生活化总结（不出现「超标 / 失败 / 还差」等施压词）。
 *
 * 按「还剩多少」分档说人话（数字降权，主行只讲生活）：
 * - 剩余 > 50%（ratio < 0.5）→「今天还很宽裕」
 * - 剩余 10%~50%（0.5 ≤ ratio ≤ 0.9）→「今天吃得差不多刚好」
 * - 剩余 < 10%（0.9 < ratio ≤ 1）→「今天吃得挺充分，早点休息」
 * - 已超过参考量（ratio > 1）→ 中性表达，不做评判
 * - 没有记录 → 摘要卡空态（`COPY.emptyTodayData`）
 *
 * @param input.intakeKcal 今天已摄入热量（kcal）
 * @param input.progressRatio 今日进度比（0 ~ 1+）
 * @returns 一句日常口吻的总结
 */
export function mealSummaryLine(input: { intakeKcal: number; progressRatio: number }): string {
  const ratio = Number.isFinite(input.progressRatio) ? input.progressRatio : 0;
  if (ratio > 1) {
    return '今天吃得丰富一些，明天照常就好';
  }
  if (!Number.isFinite(input.intakeKcal) || input.intakeKcal <= 0) {
    return COPY.emptyTodayData;
  }
  if (ratio > 0.9) {
    return '今天吃得挺充分，早点休息';
  }
  if (ratio >= 0.5) {
    return '今天吃得差不多刚好';
  }
  return '今天还很宽裕';
}

/** 首页摘要卡的小标签（胶囊里的一两个词）。 */
export function mealSummaryTag(input: { intakeKcal: number; progressRatio: number }): string {
  const ratio = Number.isFinite(input.progressRatio) ? input.progressRatio : 0;
  if (ratio > 1) {
    return '宽宽松松';
  }
  if (!Number.isFinite(input.intakeKcal) || input.intakeKcal <= 0) {
    return '刚开始';
  }
  return '舒服';
}

/** 按时段分档的生活化鼓励语（各 2~3 句，无压迫感）。 */
const ENCOURAGEMENT_POOL: Record<'morning' | 'noon' | 'afternoon' | 'evening', readonly string[]> = {
  morning: ['早上好呀，先给自己倒杯水', '早餐慢慢吃，今天会挺顺的'],
  noon: ['中午了，吃饱一点下午才有精神', '吃完起身走两步，晒晒太阳'],
  afternoon: ['下午容易嘴馋，先喝口水试试', '忙里偷个闲，伸个懒腰也挺好'],
  evening: ['晚上好，今天过得怎么样', '晚饭清淡点，睡前会舒服些'],
};

/**
 * 按时段取一句鼓励语；无记录时也可安全使用。
 *
 * @param hour 本地小时（0–23）
 * @returns 一句生活化鼓励语
 */
export function encouragementForHour(hour: number): string {
  const greeting = greetingForHour(hour);
  const bucket = greeting === '早上好' ? 'morning' : greeting === '中午好' ? 'noon' : greeting === '下午好' ? 'afternoon' : 'evening';
  const pool = ENCOURAGEMENT_POOL[bucket];
  return pool[0] ?? COPY.defaultEncouragement;
}

/**
 * 把饮水毫升换算为「第几杯 / 目标几杯」（250ml = 1 杯）。
 *
 * @param currentMl 今日已饮水（ml）
 * @param goalMl 今日目标（ml）
 * @returns `cups`：已喝完的整杯数；`goalCups`：目标杯数（目标为 0 时返回 0）
 */
export function cupProgress(currentMl: number, goalMl: number): { cups: number; goalCups: number } {
  const safeCurrent = Number.isFinite(currentMl) ? Math.max(0, currentMl) : 0;
  const safeGoal = Number.isFinite(goalMl) ? Math.max(0, goalMl) : 0;
  return {
    cups: Math.floor(safeCurrent / ML_PER_CUP),
    goalCups: safeGoal > 0 ? Math.max(1, Math.round(safeGoal / ML_PER_CUP)) : 0,
  };
}

/**
 * 水杯进度文案（配合 `role="status" aria-live` 播报）。
 *
 * @param currentMl 今日已饮水（ml）
 * @param goalMl 今日目标（ml）
 * @returns 如「今天第 3 杯水，离 6 杯又近了一步」
 */
export function cupText(currentMl: number, goalMl: number): string {
  const { cups, goalCups } = cupProgress(currentMl, goalMl);
  if (cups <= 0) {
    return goalCups > 0 ? `今天还没喝水，随手一杯就好（目标 ${goalCups} 杯）` : '今天还没喝水，随手一杯就好';
  }
  if (goalCups > 0 && cups >= goalCups) {
    return `今天第 ${cups} 杯水，已经很充足啦`;
  }
  return goalCups > 0
    ? `今天第 ${cups} 杯水，离 ${goalCups} 杯又近了一步`
    : `今天第 ${cups} 杯水，按自己的节奏来`;
}

/** 每日轻提醒的鼓励语池（本地随机挑一条；不含敏感数据，PRD §7）。 */

const REMINDER_MESSAGES: readonly string[] = [
  '记得照看好自己，喝口水，慢慢来',
  '今天也辛苦啦，吃饭的时候专心一点就好',
  '不用做到完美，记录本身就是照顾自己',
  '累了就休息一下，随时回来都可以',
  '散步十分钟，也是一种很好的休息',
];

/** 取一条轻提醒文案（按日期稳定选取，避免同一天反复随机）。 */
export function reminderMessage(dateKey: string): string {
  let hash = 0;
  for (const char of dateKey) {
    hash = (hash * 31 + char.charCodeAt(0)) % 100_000;
  }
  return REMINDER_MESSAGES[hash % REMINDER_MESSAGES.length] ?? REMINDER_MESSAGES[0]!;
}

// ---------------------------------------------------------------------------
// 阶段回顾（R11.3）
// 语气规范（AC-11.3.2 / 11.3.3 / QR-4）：指标全部是**独立陈述句**，
// 禁止 X/Y 分数式与百分比；体重只说方向与差值，不接任何判断句。
// 组件里**不允许**内联拼数字句 —— 集中在这里过红线审。
// ---------------------------------------------------------------------------

/** 档位按钮：「近 30 天」「近 365 天」（沿用体重区间措辞风格）。 */
export function periodDayOptionLabel(days: number): string {
  return `${COPY.periodDayOptionPrefix} ${days} ${COPY.periodDayOptionSuffix}`;
}

/** 区间说明：「近 30 天 · 8月25日 ~ 9月23日」。 */
export function periodRangeLine(days: number, from: string, to: string, format: (key: string) => string): string {
  return `${periodDayOptionLabel(days)} · ${format(from)} ~ ${format(to)}`;
}

/** ① 「这段时间，你有 48 天记下了点什么」—— 只有分子，**没有分母**（AC-11.3.3）。 */
export function periodLoggedDaysLine(days: number): string {
  const count = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0;
  return `这段时间，你有 ${count} 天记下了点什么`;
}

/** ② 「吃过的东西有 112 种」。 */
export function periodDistinctLine(count: number): string {
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return `吃过的东西有 ${safe} 种`;
}

/** ③ 「餐桌上一共记下了 N 笔饮食」。 */
export function periodMealEntryLine(count: number): string {
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return `餐桌上一共记下了 ${safe} 笔饮食`;
}

/** ④ 「记到最多的习惯是 喝水（41 次）」；两个并列用「、」连接。 */
export function periodHabitsLine(habits: ReadonlyArray<{ name: string; count: number }>): string {
  const list = habits
    .map((habit) => {
      const count = Number.isFinite(habit.count) ? Math.max(0, Math.floor(habit.count)) : 0;
      return `${habit.name}（${count} 次）`;
    })
    .join('、');
  return `记到最多的习惯是 ${list}`;
}

/** ⑤ 「运动了 12 次，一共 360 分钟」。 */
export function periodExerciseLine(sessions: number, totalMinutes: number): string {
  const safeSessions = Number.isFinite(sessions) ? Math.max(0, Math.floor(sessions)) : 0;
  const safeMinutes = Number.isFinite(totalMinutes) ? Math.max(0, Math.floor(totalMinutes)) : 0;
  return `运动了 ${safeSessions} 次，一共 ${safeMinutes} 分钟`;
}

/** ⑥ 下降：「这段时间体重减少了 2.3 kg」—— 后面**不接任何判断句**（QR-4）。 */
export function periodWeightDownLine(deltaKg: number): string {
  const value = Math.abs(Number.isFinite(deltaKg) ? deltaKg : 0);
  return `这段时间体重减少了 ${value} kg`;
}

/** ⑥ 上涨：「这段时间体重增加了 0.4 kg」—— 同样只是陈述，不评价。 */
export function periodWeightUpLine(deltaKg: number): string {
  const value = Math.abs(Number.isFinite(deltaKg) ? deltaKg : 0);
  return `这段时间体重增加了 ${value} kg`;
}

/** 「你写下了 N 条体重之外的变化」（唯一计数出口，AC-11.4.6）。 */
export function periodWinCountLine(count: number): string {
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return `你写下了 ${safe} 条体重之外的变化`;
}

/** 常吃榜右侧的天数：「有 41 天」。 */
export function periodTopDaysText(dayCount: number): string {
  const days = Number.isFinite(dayCount) ? Math.max(0, Math.floor(dayCount)) : 0;
  return `有 ${days} 天`;
}

// ---------------------------------------------------------------------------
// 周报多样性行（R11.7）
// 语气规范（AC-11.7.3）：只计数，不打分 —— 不评分、不推荐种类数、不说「还差 N 种」。
// ---------------------------------------------------------------------------

/** 「这周吃到了 23 种不同的食物」。 */
export function diversityCountLine(count: number): string {
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return `这周吃到了 ${safe} 种不同的食物`;
}

/** 展开行的读屏语句（AC-11.7.1）。 */
export function diversityAria(count: number, expanded: boolean): string {
  return `${diversityCountLine(count)}，${expanded ? '已展开清单' : '展开可看清单'}`;
}

// ---------------------------------------------------------------------------
// 「体重之外的变化」（R11.4）
// 语气规范（AC-11.4.1 / 11.4.5 / 11.4.6）：零压力入口 —— 无必填校验、无徽章、无里程碑；
// 不出现 徽章/成就/等级/积分/连续/奖励/解锁/星级 一类词根（标识符黑名单见 PRD §4.3）。
// ---------------------------------------------------------------------------

/** 列表日期：「今天」或「9月23日」（只记今天，列表里旧记录按天显示）。 */
export function winDateLine(dateKey: string, today: string, format: (key: string) => string): string {
  return dateKey === today ? '今天' : format(dateKey);
}

/** 「删掉这条」按钮的读屏语句（含正文前几个字，便于区分同日多条）。 */
export function winDeleteAria(text: string): string {
  const head = text.length > 8 ? `${Array.from(text).slice(0, 8).join('')}…` : text;
  return `删掉这条：${head}`;
}
