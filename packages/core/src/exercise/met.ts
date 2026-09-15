/**
 * 运动热量纯函数（R6.1 / R6.2，二期）。
 *
 * 公式（客户需求原文）：**消耗 kcal = MET × 体重 kg × 时长 h**
 * MET 参考来源：《2024 成人活动 MET 汇编》（PRD「参考来源」页要求可溯源）。
 *
 * 零 IO、零依赖；数据表为**常识级公开值**，用于估算而非运动处方。
 */

/** 单个运动活动的 MET 档位。 */
export interface MetActivity {
  /** 稳定标识（写入 `exercise_logs.activity_code`） */
  code: string;
  /** 展示名 */
  name: string;
  /** 分类：步行 / 跑步 / 水上 / 骑行 / 跳绳爬楼 / 家务 / 球类 */
  category: string;
  /** 强度档位说明（如「约 5.6 km/h」） */
  intensity: string;
  /** MET 值 */
  met: number;
}

/** 内置 MET 表（一期二期内置，后续允许用户自定义扩展）。 */
export const MET_ACTIVITY_LIBRARY: readonly MetActivity[] = [
  { code: 'walking_slow', name: '散步', category: '步行', intensity: '约 3.2 km/h', met: 3.0 },
  { code: 'walking_brisk', name: '快走', category: '步行', intensity: '约 5.6 km/h', met: 5.0 },
  { code: 'hiking', name: '徒步/爬山', category: '步行', intensity: '有坡度', met: 6.3 },
  { code: 'jogging', name: '慢跑', category: '跑步', intensity: '约 8 km/h', met: 8.3 },
  { code: 'running', name: '跑步', category: '跑步', intensity: '约 11 km/h', met: 11.0 },
  { code: 'swimming_free', name: '游泳（自由泳）', category: '水上', intensity: '中等强度', met: 8.3 },
  { code: 'swimming_leisure', name: '游泳（休闲）', category: '水上', intensity: '低强度', met: 6.0 },
  { code: 'cycling_leisure', name: '骑行（休闲）', category: '骑行', intensity: '约 16 km/h', met: 6.8 },
  { code: 'cycling_commute', name: '骑行（通勤）', category: '骑行', intensity: '约 12 km/h', met: 4.8 },
  { code: 'jump_rope', name: '跳绳', category: '跳绳爬楼', intensity: '中速', met: 11.8 },
  { code: 'stairs_up', name: '爬楼梯', category: '跳绳爬楼', intensity: '慢速', met: 8.0 },
  { code: 'housework', name: '家务', category: '家务', intensity: '轻量（拖地/整理）', met: 3.5 },
  { code: 'yoga', name: '瑜伽', category: '柔韧', intensity: '哈他', met: 2.5 },
  { code: 'badminton', name: '羽毛球', category: '球类', intensity: '休闲对打', met: 5.5 },
  { code: 'basketball', name: '篮球', category: '球类', intensity: '一般对抗', met: 8.0 },
] as const;

/** 按编码查活动；未命中返回 `undefined`（调用方给出温和提示）。 */
export function findMetActivity(code: string): MetActivity | undefined {
  return MET_ACTIVITY_LIBRARY.find((activity) => activity.code === code);
}

/**
 * 计算运动消耗 kcal：**MET × 体重 kg × 时长 h**。
 *
 * @param met 活动 MET 值（须 > 0）
 * @param weightKg 体重 kg（须 > 0）
 * @param minutes 时长分钟（须 ≥ 0）
 * @returns 消耗 kcal（保留 1 位小数）；入参非法时返回 0（调用方可据此给温和提示）
 */
export function calcExerciseKcal(met: number, weightKg: number, minutes: number): number {
  if (!Number.isFinite(met) || met <= 0 || !Number.isFinite(weightKg) || weightKg <= 0) {
    return 0;
  }
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 0;
  }
  const kcal = met * weightKg * (minutes / 60);
  return Math.round(kcal * 10) / 10;
}

/**
 * 「吃掉它需要多少运动」：把某个热量数换算成某活动的分钟数（R5.2 零食救赎）。
 *
 * 反解 `calcExerciseKcal`：minutes = kcal ÷ (MET × kg) × 60。
 *
 * @param kcal 目标热量（> 0）
 * @param met 活动 MET（> 0）
 * @param weightKg 体重 kg（> 0）
 * @returns 分钟数（向上取整到整数分钟，便于口头表达）；入参非法返回 0
 */
export function exerciseMinutesForKcal(kcal: number, met: number, weightKg: number): number {
  if (!Number.isFinite(kcal) || kcal <= 0 || !Number.isFinite(met) || met <= 0) {
    return 0;
  }
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    return 0;
  }
  const minutes = (kcal / (met * weightKg)) * 60;
  return Math.ceil(minutes);
}
