import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OnboardingDto } from './dto/onboarding.dto';
import { UpdateGoalDto } from './dto/update-goal.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { UsersService } from './users.service';
import type { MeResult, OnboardingResult, ProfileResult, ProfileUpdateResult } from './users.service';
import type { UserSettings } from '@qsh/shared-types';

/**
 * 引导问卷 / 资料 / 目标 / 设置（R1.3 / R1.4）。
 * 全部接口受 `JwtAuthGuard` 保护，`userId` 一律取自 JWT（K7）。
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** 提交引导问卷：服务端重算并落库（TC-12）。 */
  @Post('onboarding')
  @HttpCode(HttpStatus.OK)
  completeOnboarding(
    @CurrentUser() userId: number,
    @Body() dto: OnboardingDto,
  ): Promise<OnboardingResult> {
    return this.usersService.completeOnboarding(userId, dto);
  }

  /** 资料 + 目标 + 设置（含重算摘要）。 */
  @Get('profile')
  getProfile(@CurrentUser() userId: number): Promise<ProfileResult> {
    return this.usersService.getProfile(userId);
  }

  /** 修改基础数据 → 服务端重算并落库（TC-12）。 */
  @Patch('profile')
  updateProfile(
    @CurrentUser() userId: number,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileUpdateResult> {
    return this.usersService.updateProfile(userId, dto);
  }

  /** 修改目标 → 追加历史 + 重算落库。 */
  @Patch('goals')
  updateGoal(@CurrentUser() userId: number, @Body() dto: UpdateGoalDto): Promise<ProfileUpdateResult> {
    return this.usersService.updateGoal(userId, dto);
  }

  /** 读取设置。 */
  @Get('settings')
  getSettings(@CurrentUser() userId: number): Promise<UserSettings> {
    return this.usersService.getSettings(userId);
  }

  /** 修改设置（单位 / 深色 / 饮水目标 / 断食开关）。 */
  @Patch('settings')
  updateSettings(
    @CurrentUser() userId: number,
    @Body() dto: UpdateSettingsDto,
  ): Promise<UserSettings> {
    return this.usersService.updateSettings(userId, dto);
  }

  /** 当前用户概览（与 `/auth/me` 同构，便于前端复用）。 */
  @Get('me')
  getMe(@CurrentUser() userId: number): Promise<MeResult> {
    return this.usersService.getMe(userId);
  }
}
