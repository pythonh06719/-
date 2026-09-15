import { Injectable } from '@nestjs/common';

import { DEFAULT_MACRO_RATIO, ageFromBirthDate } from '@qsh/core';
import type { ActivityLevel, CalorieResult, Gender, MacroRatio, ValidationWarning } from '@qsh/core';
import type { User, UserGoal, UserProfile, UserSettings } from '@qsh/shared-types';

import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import {
  toUser,
  toUserGoal,
  toUserProfile,
  toUserSettings,
} from '../common/mappers/entity.mapper';
import { todayLocalKey } from '../common/utils/date.util';
import { PrismaService } from '../prisma/prisma.service';
import { BudgetService } from './budget.service';
import { OnboardingDto } from './dto/onboarding.dto';
import { UpdateGoalDto } from './dto/update-goal.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';

/** `POST /api/onboarding` 响应（含服务端重算的 `budget` 与告警）。 */
export interface OnboardingResult {
  profile: UserProfile;
  goal: UserGoal;
  settings: UserSettings;
  budget: CalorieResult;
  warnings: ValidationWarning[];
}

/** `GET /api/profile` 响应。 */
export interface ProfileResult {
  profile: UserProfile | null;
  goal: UserGoal | null;
  settings: UserSettings;
  budget: CalorieResult | null;
  warnings: ValidationWarning[];
}

/** `PATCH /api/profile` / `PATCH /api/goals` 响应。 */
export interface ProfileUpdateResult {
  profile: UserProfile;
  goal: UserGoal;
  budget: CalorieResult;
  warnings: ValidationWarning[];
}

/** `GET /api/auth/me` 响应。 */
export interface MeResult {
  user: User;
  profile: UserProfile | null;
  goal: UserGoal | null;
  settings: UserSettings;
}

/**
 * 用户资料 / 目标 / 设置服务（R1.3 / R1.4 / TC-12）。
 *
 * **核心约束**：任何影响热量指标的基础数据变更，都必须**服务端重算并落库**（禁止前端伪造数字）。
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budgetService: BudgetService,
  ) {}

  /** 当前登录用户 + 资料 + 目标 + 设置（`GET /api/auth/me`）。 */
  async getMe(userId: number): Promise<MeResult> {
    const userRow = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!userRow) {
      // 账号已被硬删除（R10.4）：旧 token 不再对应有效会话 → 401，而非 404
      throw new ApiException(401, ERROR_CODES.AUTH_INVALID_TOKEN, '登录状态已失效，请重新登录');
    }
    const [profileRow, goalRow, settings] = await Promise.all([
      this.prisma.userProfile.findUnique({ where: { userId } }),
      this.prisma.userGoal.findUnique({ where: { userId } }),
      this.ensureSettings(userId),
    ]);

    return {
      user: toUser(userRow),
      profile: profileRow ? toUserProfile(profileRow) : null,
      goal: goalRow ? toUserGoal(goalRow) : null,
      settings,
    };
  }

  /**
   * 完成引导问卷（R1.3）：服务端调用 `@qsh/core` 计算并落库，
   * 追加一条 `weight_goal_history`，并写入一条当日起始体重记录。
   */
  async completeOnboarding(userId: number, dto: OnboardingDto): Promise<OnboardingResult> {
    const now = new Date();
    const nowIso = now.toISOString();
    const today = todayLocalKey(now);

    const birthDate = dto.birthDate ?? this.birthDateFromAge(dto.age, now);
    if (!birthDate) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '请填写出生日期', {
        birthDate: '请填写出生日期或年龄',
      });
    }

    const age = this.ageFromBirthDate(birthDate, now);
    const macroRatio = this.normalizeMacroRatio(dto.macroRatio);
    const derived = this.budgetService.deriveWeeklyLossKg(
      dto.currentWeightKg,
      dto.targetWeightKg,
      dto.targetWeeks,
    );
    const weeklyLossKg = derived > 0 ? derived : 0;

    const budget = this.budgetService.compute({
      gender: dto.gender,
      age,
      heightCm: dto.heightCm,
      weightKg: dto.currentWeightKg,
      targetWeightKg: dto.targetWeightKg,
      targetWeeks: dto.targetWeeks,
      activityLevel: dto.activityLevel,
      macroRatio,
      ...(derived > 0 ? { weeklyLossKg: derived } : {}),
    });

    const dietaryPreference = dto.dietaryPreference ?? [];
    const conditions = dto.conditions ?? [];

    await this.prisma.$transaction(async (tx) => {
      const profileData = {
        gender: dto.gender,
        birthDate,
        heightCm: dto.heightCm,
        activityLevel: dto.activityLevel,
        dietaryPreference: JSON.stringify(dietaryPreference),
        conditions: JSON.stringify(conditions),
        onboardingCompletedAt: nowIso,
        updatedAt: nowIso,
      };

      await tx.userProfile.upsert({
        where: { userId },
        create: {
          userId,
          ...profileData,
          disclaimerAcceptedAt: dto.disclaimerAccepted ? nowIso : null,
        },
        update: {
          ...profileData,
          ...(dto.disclaimerAccepted ? { disclaimerAcceptedAt: nowIso } : {}),
        },
      });

      const goalData = {
        startWeightKg: dto.currentWeightKg,
        targetWeightKg: dto.targetWeightKg,
        targetWeeks: dto.targetWeeks,
        weeklyLossKg,
        macroRatio: JSON.stringify(macroRatio),
        isActive: true,
        updatedAt: nowIso,
      };
      await tx.userGoal.upsert({
        where: { userId },
        create: { userId, ...goalData },
        update: goalData,
      });

      await tx.weightGoalHistory.create({
        data: {
          userId,
          startWeightKg: dto.currentWeightKg,
          targetWeightKg: dto.targetWeightKg,
          targetWeeks: dto.targetWeeks,
          weeklyLossKg,
          macroRatio: JSON.stringify(macroRatio),
          effectiveFrom: today,
        },
      });

      await tx.userSettings.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });

      await tx.weightLog.upsert({
        where: { userId_loggedAt: { userId, loggedAt: today } },
        create: { userId, loggedAt: today, weightKg: dto.currentWeightKg, source: 'manual' },
        update: { weightKg: dto.currentWeightKg },
      });
    });

    const loaded = await this.loadProfileGoalSettings(userId);
    if (!loaded.profile || !loaded.goal) {
      throw new ApiException(500, ERROR_CODES.INTERNAL, '引导信息未能保存，请稍后再试');
    }
    return {
      profile: loaded.profile,
      goal: loaded.goal,
      settings: loaded.settings,
      budget,
      warnings: budget.warnings,
    };
  }

  /** `GET /api/profile`：资料 + 目标 + 设置（含重算摘要）。 */
  async getProfile(userId: number): Promise<ProfileResult> {
    const { profile, goal, settings } = await this.loadProfileGoalSettings(userId);

    if (!profile || !goal) {
      return { profile: profile ?? null, goal: goal ?? null, settings, budget: null, warnings: [] };
    }

    const budget = this.budgetService.computeFromProfileAndGoal(profile, goal);
    return { profile, goal, settings, budget, warnings: budget.warnings };
  }

  /**
   * `PATCH /api/profile`：部分更新基础数据 → **服务端重算并落库**（TC-12）。
   */
  async updateProfile(userId: number, dto: UpdateProfileDto): Promise<ProfileUpdateResult> {
    const existing = await this.loadProfileGoalSettings(userId);
    if (!existing.profile || !existing.goal) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_PROFILE, '请先完成引导问卷');
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const today = todayLocalKey(now);

    const profile = existing.profile;
    const goal = existing.goal;

    const gender: Gender = dto.gender ?? profile.gender;
    const birthDate = dto.birthDate ?? profile.birthDate;
    const heightCm = dto.heightCm ?? profile.heightCm;
    const activityLevel: ActivityLevel = dto.activityLevel ?? profile.activityLevel;
    const dietaryPreference = dto.dietaryPreference ?? profile.dietaryPreference;
    const conditions = dto.conditions ?? profile.conditions;

    const macroRatio = dto.macroRatio ? this.normalizeMacroRatio(dto.macroRatio) : goal.macroRatio;
    const startWeightKg = dto.currentWeightKg ?? goal.startWeightKg;
    const targetWeightKg = dto.targetWeightKg ?? goal.targetWeightKg;
    const targetWeeks = dto.targetWeeks ?? goal.targetWeeks;

    const derived = this.budgetService.deriveWeeklyLossKg(startWeightKg, targetWeightKg, targetWeeks);
    const weeklyLossKg = derived > 0 ? derived : 0;

    const budget = this.budgetService.compute({
      gender,
      age: this.ageFromBirthDate(birthDate, now),
      heightCm,
      weightKg: startWeightKg,
      targetWeightKg,
      targetWeeks,
      activityLevel,
      macroRatio,
      ...(derived > 0 ? { weeklyLossKg: derived } : {}),
    });

    const goalChanged =
      dto.targetWeightKg !== undefined || dto.targetWeeks !== undefined || dto.macroRatio !== undefined;

    await this.prisma.$transaction(async (tx) => {
      await tx.userProfile.update({
        where: { userId },
        data: {
          gender,
          birthDate,
          heightCm,
          activityLevel,
          dietaryPreference: JSON.stringify(dietaryPreference),
          conditions: JSON.stringify(conditions),
          updatedAt: nowIso,
        },
      });

      await tx.userGoal.update({
        where: { userId },
        data: {
          startWeightKg,
          targetWeightKg,
          targetWeeks,
          weeklyLossKg,
          macroRatio: JSON.stringify(macroRatio),
          updatedAt: nowIso,
        },
      });

      if (goalChanged) {
        await tx.weightGoalHistory.create({
          data: {
            userId,
            startWeightKg,
            targetWeightKg,
            targetWeeks,
            weeklyLossKg,
            macroRatio: JSON.stringify(macroRatio),
            effectiveFrom: today,
          },
        });
      }

      if (dto.currentWeightKg !== undefined) {
        await tx.weightLog.upsert({
          where: { userId_loggedAt: { userId, loggedAt: today } },
          create: { userId, loggedAt: today, weightKg: dto.currentWeightKg, source: 'manual' },
          update: { weightKg: dto.currentWeightKg },
        });
      }
    });

    const updated = await this.loadProfileGoalSettings(userId);
    return {
      profile: updated.profile as UserProfile,
      goal: updated.goal as UserGoal,
      budget,
      warnings: budget.warnings,
    };
  }

  /** `PATCH /api/goals`：目标变更 → 追加历史 + 重算落库。 */
  async updateGoal(userId: number, dto: UpdateGoalDto): Promise<ProfileUpdateResult> {
    return this.updateProfile(userId, dto);
  }

  /** `GET /api/settings`。 */
  async getSettings(userId: number): Promise<UserSettings> {
    return this.ensureSettings(userId);
  }

  /** `PATCH /api/settings`。 */
  async updateSettings(userId: number, dto: UpdateSettingsDto): Promise<UserSettings> {
    await this.ensureSettings(userId);
    const row = await this.prisma.userSettings.update({
      where: { userId },
      data: {
        ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
        ...(dto.darkMode !== undefined ? { darkMode: dto.darkMode } : {}),
        ...(dto.waterGoalMl !== undefined ? { waterGoalMl: dto.waterGoalMl } : {}),
        ...(dto.fastingEnabled !== undefined ? { fastingEnabled: dto.fastingEnabled } : {}),
        updatedAt: new Date().toISOString(),
      },
    });
    return toUserSettings(row);
  }

  /** 确保 `user_settings` 存在（1:1 扩展表），返回映射后的设置。 */
  async ensureSettings(userId: number): Promise<UserSettings> {
    const row = await this.prisma.userSettings.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    return toUserSettings(row);
  }

  /** 读取并映射资料 / 目标 / 设置三元组。 */
  private async loadProfileGoalSettings(userId: number): Promise<{
    profile: UserProfile | null;
    goal: UserGoal | null;
    settings: UserSettings;
  }> {
    const [profileRow, goalRow, settings] = await Promise.all([
      this.prisma.userProfile.findUnique({ where: { userId } }),
      this.prisma.userGoal.findUnique({ where: { userId } }),
      this.ensureSettings(userId),
    ]);
    return {
      profile: profileRow ? toUserProfile(profileRow) : null,
      goal: goalRow ? toUserGoal(goalRow) : null,
      settings,
    };
  }

  /** 归一宏量比例（缺省 25/25/50）。 */
  private normalizeMacroRatio(ratio?: MacroRatio): MacroRatio {
    if (!ratio) {
      return { ...DEFAULT_MACRO_RATIO };
    }
    return { protein: ratio.protein, fat: ratio.fat, carb: ratio.carb };
  }

  /** 由周岁推算出生日期（仅在客户端未提供 `birthDate` 时使用）。 */
  private birthDateFromAge(age: number | undefined, now: Date): string | undefined {
    if (age === undefined || !Number.isInteger(age) || age <= 0) {
      return undefined;
    }
    const date = new Date(now.getFullYear() - age, now.getMonth(), now.getDate());
    return todayLocalKey(date);
  }

  /** 由出生日期算周岁（复用引擎纯函数，避免本地重复实现）。 */
  private ageFromBirthDate(birthDate: string, now: Date): number {
    return ageFromBirthDate(birthDate, now);
  }
}
