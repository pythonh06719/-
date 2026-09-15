/**
 * Prisma 行 → 共享契约实体 的映射（ARCHITECTURE §3.2）。
 *
 * - JSON 列（`aliases` / `serving_units` / `dietary_preference` / `conditions` / `macro_ratio`）
 *   在 SQLite 下是 TEXT，映射层负责 `JSON.parse`；
 * - 布尔列由 Prisma 归一为 `boolean`，无需转换；
 * - 枚举列 DB 为 TEXT，映射为字符串联合类型。
 *
 * ⚠️ 本文件不重复定义类型：实体类型一律来自 `@qsh/shared-types`。
 */

import { DEFAULT_MACRO_RATIO } from '@qsh/core';
import type { ActivityLevel, Gender, MacroRatio } from '@qsh/core';
import type {
  FoodFavorite,
  FoodItem,
  MealCombo,
  MealComboItem,
  MealLog,
  MealLogSource,
  MealType,
  ServingUnit,
  User,
  UserGoal,
  UserProfile,
  UserSettings,
  VerificationPurpose,
  WeightLog,
  WeightLogSource,
} from '@qsh/shared-types';
import type {
  FoodItem as FoodItemRow,
  MealCombo as MealComboRow,
  MealComboItem as MealComboItemRow,
  MealLog as MealLogRow,
  User as UserRow,
  UserGoal as UserGoalRow,
  UserProfile as UserProfileRow,
  UserSettings as UserSettingsRow,
  WeightLog as WeightLogRow,
} from '@prisma/client';

/** 安全解析 JSON 字符串数组；失败返回 `[]`。 */
export function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 安全解析 `serving_units` JSON；失败返回 `[]`。 */
export function parseServingUnits(raw: string | null | undefined): ServingUnit[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        unit: String(item.unit ?? ''),
        grams: Number(item.grams ?? 0),
        ...(typeof item.isDefault === 'boolean' ? { isDefault: item.isDefault } : {}),
        ...(typeof item.label === 'string' ? { label: item.label } : {}),
      }))
      .filter((item) => item.unit.length > 0 && Number.isFinite(item.grams) && item.grams > 0);
  } catch {
    return [];
  }
}

/** 安全解析 `macro_ratio` JSON；失败回退默认比例。 */
export function parseMacroRatio(raw: string | null | undefined): MacroRatio {
  if (!raw) {
    return { ...DEFAULT_MACRO_RATIO };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const protein = Number(record.protein ?? 0);
      const fat = Number(record.fat ?? 0);
      const carb = Number(record.carb ?? 0);
      if (Number.isFinite(protein) && Number.isFinite(fat) && Number.isFinite(carb)) {
        return { protein, fat, carb };
      }
    }
  } catch {
    /* 回退默认 */
  }
  return { ...DEFAULT_MACRO_RATIO };
}

/** `users` 行 → `User`。 */
export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    emailVerifiedAt: row.emailVerifiedAt,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `user_profiles` 行 → `UserProfile`。 */
export function toUserProfile(row: UserProfileRow): UserProfile {
  return {
    userId: row.userId,
    gender: row.gender as Gender,
    birthDate: row.birthDate,
    heightCm: row.heightCm,
    activityLevel: row.activityLevel as ActivityLevel,
    dietaryPreference: parseJsonStringArray(row.dietaryPreference),
    conditions: parseJsonStringArray(row.conditions),
    disclaimerAcceptedAt: row.disclaimerAcceptedAt,
    onboardingCompletedAt: row.onboardingCompletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `user_goals` 行 → `UserGoal`。 */
export function toUserGoal(row: UserGoalRow): UserGoal {
  return {
    userId: row.userId,
    startWeightKg: row.startWeightKg,
    targetWeightKg: row.targetWeightKg,
    targetWeeks: row.targetWeeks,
    weeklyLossKg: row.weeklyLossKg,
    macroRatio: parseMacroRatio(row.macroRatio),
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `user_settings` 行 → `UserSettings`。 */
export function toUserSettings(row: UserSettingsRow): UserSettings {
  return {
    userId: row.userId,
    unit: row.unit === 'kj' ? 'kj' : 'kcal',
    darkMode: row.darkMode,
    waterGoalMl: row.waterGoalMl,
    fastingEnabled: row.fastingEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `weight_logs` 行 → `WeightLog`。 */
export function toWeightLog(row: WeightLogRow): WeightLog {
  return {
    id: row.id,
    userId: row.userId,
    loggedAt: row.loggedAt,
    weightKg: row.weightKg,
    note: row.note,
    source: row.source as WeightLogSource,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `food_items` 行 → `FoodItem`。 */
export function toFoodItem(row: FoodItemRow): FoodItem {
  return {
    id: row.id,
    name: row.name,
    namePinyin: row.namePinyin,
    aliases: parseJsonStringArray(row.aliases),
    category: row.category,
    kcalPer100g: row.kcalPer100g,
    proteinGPer100g: row.proteinGPer100g,
    fatGPer100g: row.fatGPer100g,
    carbGPer100g: row.carbGPer100g,
    fiberGPer100g: row.fiberGPer100g,
    sodiumMgPer100g: row.sodiumMgPer100g,
    saturatedFatGPer100g: row.saturatedFatGPer100g,
    sugarGPer100g: row.sugarGPer100g,
    calciumMgPer100g: row.calciumMgPer100g,
    ironMgPer100g: row.ironMgPer100g,
    potassiumMgPer100g: row.potassiumMgPer100g,
    vitaminDUgPer100g: row.vitaminDUgPer100g,
    b12UgPer100g: row.b12UgPer100g,
    magnesiumMgPer100g: row.magnesiumMgPer100g,
    servingUnits: parseServingUnits(row.servingUnits),
    defaultServingGrams: row.defaultServingGrams,
    barcode: row.barcode,
    source: row.source as FoodItem['source'],
    createdByUserId: row.createdByUserId,
    isVerified: row.isVerified,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `meal_logs` 行 → `MealLog`。 */
export function toMealLog(row: MealLogRow): MealLog {
  return {
    id: row.id,
    userId: row.userId,
    loggedDate: row.loggedDate,
    mealType: row.mealType as MealType,
    foodItemId: row.foodItemId,
    customName: row.customName,
    grams: row.grams,
    servingUnit: row.servingUnit,
    servingQty: row.servingQty,
    kcal: row.kcal,
    proteinG: row.proteinG,
    fatG: row.fatG,
    carbG: row.carbG,
    fiberG: row.fiberG,
    sodiumMg: row.sodiumMg,
    source: row.source as MealLogSource,
    comboId: row.comboId,
    note: row.note,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `meal_combo_items` 行 → `MealComboItem`。 */
export function toMealComboItem(row: MealComboItemRow): MealComboItem {
  return {
    id: row.id,
    comboId: row.comboId,
    foodItemId: row.foodItemId,
    customName: row.customName,
    grams: row.grams,
    servingUnit: row.servingUnit,
    servingQty: row.servingQty,
    kcal: row.kcal,
    proteinG: row.proteinG,
    fatG: row.fatG,
    carbG: row.carbG,
    sortOrder: row.sortOrder,
  };
}

/** `meal_combos` 行（含 items）→ `MealCombo & { items }`。 */
export function toMealCombo(row: MealComboRow & { items: MealComboItemRow[] }): MealCombo & {
  items: MealComboItem[];
} {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    mealType: row.mealType as MealType,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    items: [...row.items]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      .map((item) => toMealComboItem(item)),
  };
}

/** `food_favorites` 行（含 foodItem）→ `FoodFavorite`。 */
export function toFoodFavorite(row: { userId: number; foodItemId: number; createdAt: string }): FoodFavorite {
  return {
    userId: row.userId,
    foodItemId: row.foodItemId,
    createdAt: row.createdAt,
  };
}

/** 供 DTO / 服务层复用的验证码用途联合类型。 */
export type { VerificationPurpose };
