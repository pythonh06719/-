/**
 * 生活化工具纯函数（R5.1~R5.4，二期 —— 产品差异化重点）。
 *
 * 全部为**估算**：给区间而非精确值，并始终附「这样点更健康」的建议。
 * 语气遵循 PRD §7：鼓励式、不贩卖焦虑，**严禁**「超标」「不健康就别吃」式表达。
 *
 * 数值为常识级公开区间，供日常参考，不构成营养诊断。
 */

import { exerciseMinutesForKcal } from '../exercise/met';

/** 外卖类型（R5.1）。 */
export type TakeoutKind =
  | 'malatang'
  | 'braised_chicken'
  | 'salad'
  | 'bento'
  | 'noodle_soup'
  | 'burger';

/** 份量估算区间（kcal）。 */
export interface KcalRange {
  min: number;
  max: number;
}

/** 外卖条目。 */
export interface TakeoutItem {
  kind: TakeoutKind;
  name: string;
  /** 按常见整份估算 */
  range: KcalRange;
  /** 估算假设（透明化，数字可溯源的口径说明） */
  assumption: string;
  /** 「这样点更健康」替换建议（2~3 条） */
  swaps: string[];
}

/** 内置外卖库（麻辣烫/黄焖鸡/轻食沙拉等常见品类）。 */
export const TAKEOUT_LIBRARY: readonly TakeoutItem[] = [
  {
    kind: 'malatang',
    name: '麻辣烫',
    range: { min: 450, max: 1100 },
    assumption: '按一整碗（含汤底、荤素自选约 400–600g）估算；选麻辣汤底 + 多丸子会偏高',
    swaps: [
      '选清汤或番茄汤底，能省下 150–300 kcal',
      '多拿绿叶菜和豆制品，丸子类减半',
      '麻酱/辣油减半 —— 酱料常比主菜更“热量密集”',
    ],
  },
  {
    kind: 'braised_chicken',
    name: '黄焖鸡米饭',
    range: { min: 700, max: 1000 },
    assumption: '按标准份（鸡块 + 米饭一盒 + 汤汁拌饭）估算',
    swaps: [
      '米饭要小份，汤汁别拌饭（汤汁吸油最多）',
      '加一份杏鲍菇或青椒，蔬菜更扛饿',
      '去皮鸡块能再省一些',
    ],
  },
  {
    kind: 'salad',
    name: '轻食沙拉',
    range: { min: 250, max: 750 },
    assumption: '差异主要来自酱汁与配料：油醋汁偏低，千岛/凯撒酱与牛油果、坚果偏高',
    swaps: [
      '酱汁换油醋汁，或减半分开装',
      '加一份鸡胸/水煮蛋，蛋白质更够饿得慢',
      '别因为“沙拉”就放空主食，可以加半份杂粮',
    ],
  },
  {
    kind: 'bento',
    name: '台式卤肉饭/便当',
    range: { min: 600, max: 950 },
    assumption: '按一份主菜 + 半荤 + 米饭一盒估算',
    swaps: [
      '肥肉换瘦肉，配菜选清炒而非油炸',
      '米饭减 1/3，吃饱主要靠蛋白质和纤维',
      '有汤先喝汤（清汤），垫底更抗饿',
    ],
  },
  {
    kind: 'noodle_soup',
    name: '汤面（牛肉面/米线）',
    range: { min: 500, max: 900 },
    assumption: '按一碗（面 200g + 汤底 + 常规浇头）估算；红油汤底偏高',
    swaps: [
      '汤喝一半，盐和油都在汤里',
      '加一份烫青菜，份量更足',
      '选牛肉或鸡肉浇头，别选油炸浇头',
    ],
  },
  {
    kind: 'burger',
    name: '汉堡套餐',
    range: { min: 800, max: 1300 },
    assumption: '按汉堡 + 中薯 + 中杯含糖饮料估算',
    swaps: [
      '饮料换无糖气泡水或白水，省下最多的一块',
      '薯条换成玉米杯或苹果派之外的水果',
      '汉堡去掉酱料包，味道仍够',
    ],
  },
] as const;

/** 按类型查外卖估算；未命中返回 `undefined`。 */
export function estimateTakeout(kind: string): TakeoutItem | undefined {
  return TAKEOUT_LIBRARY.find((item) => item.kind === kind);
}

/** 聚餐类型（R5.3）。 */
export type FeastKind = 'hotpot' | 'bbq' | 'buffet';

/** 聚餐估算结果。 */
export interface FeastEstimate {
  kind: FeastKind;
  name: string;
  /** 人均摄入区间（不含酒水） */
  perPerson: KcalRange;
  assumption: string;
  /** 当天其他餐的调整建议（鼓励式） */
  adjustTips: string[];
}

/** 内置聚餐库。 */
export const FEAST_LIBRARY: readonly FeastEstimate[] = [
  {
    kind: 'hotpot',
    name: '火锅',
    perPerson: { min: 900, max: 1800 },
    assumption: '按人均（锅底 + 蘸料 + 荤素涮品）估算；麻辣锅底与麻酱蘸料显著拉高',
    adjustTips: [
      '清汤锅底 + 干碟，是省热量的最大杠杆',
      '多吃蔬菜和菌菇，肉类选鱼片/虾滑',
      '当天早午餐可以吃得清淡些，把额度留给聚餐 —— 这就是弹性，不是失控',
    ],
  },
  {
    kind: 'bbq',
    name: '烧烤',
    perPerson: { min: 1000, max: 2000 },
    assumption: '按人均（肉串 + 烤蔬菜 + 主食 + 饮料）估算',
    adjustTips: [
      '多点烤蔬菜（韭菜/金针菇/茄子）和烤豆腐',
      '烤肉选瘦肉串，少刷酱',
      '酒水换无糖茶 —— 液体热量最容易被忽略',
    ],
  },
  {
    kind: 'buffet',
    name: '自助餐',
    perPerson: { min: 1200, max: 2400 },
    assumption: '按人均自由取食估算，个体差异最大',
    adjustTips: [
      '先逛一圈再拿，拿小份多试几样',
      '蛋白质和蔬菜先垫底，甜品留到最后浅尝',
      '吃惬意一点，第二天照常记录就好 —— 看趋势，不看单日',
    ],
  },
] as const;

/** 按类型查聚餐估算；未命中返回 `undefined`。 */
export function estimateFeast(kind: string): FeastEstimate | undefined {
  return FEAST_LIBRARY.find((item) => item.kind === kind);
}

/** 奶茶糖度档位（对应含糖量系数）。 */
export type SugarLevel = 'none' | 'light' | 'half' | 'regular' | 'full';

/** 糖度系数（相对全糖）。 */
const SUGAR_FACTOR: Record<SugarLevel, number> = {
  none: 0.55,
  light: 0.75,
  half: 0.85,
  regular: 1.0,
  full: 1.15,
};

/** 饮品条目。 */
export interface DrinkItem {
  kind: DrinkKind;
  name: string;
  /** 每 100 ml 热量（标准糖度） */
  kcalPer100ml: number;
  /** 常见杯型 ml */
  defaultSizeMl: number;
  /** 低卡点单攻略 */
  tips: string[];
}

/** 饮品类型（R5.4）。 */
export type DrinkKind = 'milk_tea' | 'fruit_tea' | 'americano' | 'latte' | 'cola' | 'beer' | 'juice';

/** 内置饮品库。 */
export const DRINK_LIBRARY: readonly DrinkItem[] = [
  {
    kind: 'milk_tea',
    name: '奶茶（珍珠奶盖另计）',
    kcalPer100ml: 65,
    defaultSizeMl: 500,
    tips: ['选三分糖或无糖，中杯更合适', '奶盖是热量大头，去奶盖', '珍珠减半，口感仍保留'],
  },
  {
    kind: 'fruit_tea',
    name: '水果茶',
    kcalPer100ml: 40,
    defaultSizeMl: 500,
    tips: ['少糖版本已经很友好', '要求不额外加糖浆', '果肉多、汤底少，饱腹更强'],
  },
  {
    kind: 'americano',
    name: '美式咖啡',
    kcalPer100ml: 2,
    defaultSizeMl: 350,
    tips: ['热量基本可以忽略', '怕苦可以加奶不加糖'],
  },
  {
    kind: 'latte',
    name: '拿铁',
    kcalPer100ml: 43,
    defaultSizeMl: 360,
    tips: ['换脱脂奶或燕麦奶', '不加糖浆（香草/榛果糖浆很隐形）'],
  },
  {
    kind: 'cola',
    name: '可乐',
    kcalPer100ml: 43,
    defaultSizeMl: 500,
    tips: ['无糖版本几乎为零热量', '点小杯 —— 满足感主要在前几口'],
  },
  {
    kind: 'beer',
    name: '啤酒',
    kcalPer100ml: 43,
    defaultSizeMl: 500,
    tips: ['瓶数比种类更影响总量', '配菜选毛豆/坚果（少量）而非炸物'],
  },
  {
    kind: 'juice',
    name: '果汁（鲜榨/瓶装）',
    kcalPer100ml: 48,
    defaultSizeMl: 300,
    tips: ['直接吃水果更扛饿（有纤维）', '榨汁不加糖，果渣保留'],
  },
] as const;

/** 饮品估算结果。 */
export interface DrinkEstimate {
  name: string;
  /** 按杯型与糖度折算的热量区间（±10% 经验浮动） */
  range: KcalRange;
  sizeMl: number;
  sugarLevel: SugarLevel;
  tips: string[];
}

/**
 * 估算饮品热量：`每 100ml 标准糖度热量 × 杯型 ml / 100 × 糖度系数`。
 *
 * 未知名与糖度按默认值处理（奶茶/中杯/正常糖），保证函数永远可用。
 */
export function estimateDrink(kind: string, sizeMl?: number, sugarLevel?: string): DrinkEstimate {
  const item = DRINK_LIBRARY.find((drink) => drink.kind === kind) ?? DRINK_LIBRARY[0]!;
  const level: SugarLevel =
    sugarLevel !== undefined && sugarLevel in SUGAR_FACTOR
      ? (sugarLevel as SugarLevel)
      : 'regular';
  const size = Number.isFinite(sizeMl) && (sizeMl as number) > 0 ? (sizeMl as number) : item.defaultSizeMl;

  const base = (item.kcalPer100ml * size * SUGAR_FACTOR[level]) / 100;
  const round = (value: number): number => Math.round(value);
  return {
    name: item.name,
    range: { min: round(base * 0.9), max: round(base * 1.1) },
    sizeMl: size,
    sugarLevel: level,
    tips: item.tips,
  };
}

/** 零食救赎结果（R5.2）。 */
export interface SnackRedemption {
  name: string;
  /** 该零食的热量估算（kcal） */
  kcal: number;
  /** 常见低卡替代（含大致省下的量） */
  swaps: string[];
  /** 「吃掉它需要多少运动」换算（分钟） */
  exercise: Array<{ activityName: string; met: number; minutes: number }>;
}

/** 零食常见替代建议（按热量量级粗分）。 */
const SNACK_SWAPS_LIGHT: readonly string[] = [
  '换成无糖酸奶 + 几颗蓝莓，饱腹感更强',
  '换成一小把原味坚果（约 15g）',
  '先喝一杯水，很多时候是渴不是饿',
];

const SNACK_SWAPS_HEAVY: readonly string[] = [
  '换成烤鹰嘴豆或海苔，脆感保住、热量减半以上',
  '换成冻干水果或一个苹果，甜味满足但纤维更足',
  '分装成小袋 —— 不是不能吃，是不太容易被“整包吃掉”',
];

/**
 * 零食救赎：给替代建议 + 「吃掉它需要多少运动」换算。
 *
 * 固定换算三种日常可得的活动：散步 3.0 / 快走 5.0 / 慢跑 8.3 MET。
 */
export function snackRedemption(
  name: string,
  kcal: number,
  weightKg: number,
  activityLookup: (code: string) => { name: string; met: number } | undefined,
): SnackRedemption {
  const safeKcal = Number.isFinite(kcal) && kcal > 0 ? kcal : 0;
  const codes = ['walking_slow', 'walking_brisk', 'jogging'] as const;
  const exercise = codes.flatMap((code) => {
    const activity = activityLookup(code);
    if (!activity) {
      return [];
    }
    const minutes = exerciseMinutesForKcal(safeKcal, activity.met, weightKg);
    return [{ activityName: activity.name, met: activity.met, minutes }];
  });

  const swaps = safeKcal >= 350 ? SNACK_SWAPS_HEAVY : SNACK_SWAPS_LIGHT;
  return { name, kcal: safeKcal, swaps: [...swaps], exercise };
}
