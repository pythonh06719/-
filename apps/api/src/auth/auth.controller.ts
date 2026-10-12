import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';

import type { AuthResponse } from '@qsh/shared-types';

import { CurrentUser } from '../common/decorators/current-user';
import { AuthThrottlerGuard } from '../common/guards/auth-throttler.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import type { SendCodeResult } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SendCodeDto } from './dto/send-code.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';

/**
 * 鉴权控制器（`/api/auth/**`）。
 *
 * - `send-code` 额外挂 `ThrottlerGuard` + 1 分钟 5 次限流（ARCHITECTURE §1.7）。
 * - `verify-code` / `login` 挂 `AuthThrottlerGuard`（email+IP 复合键，1 分钟 5 次）：
 *   上线前全检 F-002 / F-003 —— 两条路径此前零限流，验证码 6 位 + 失败不消费，
 *   可被暴力枚举至账号接管。限流拒绝发生在 bcrypt 比对**之前**（守卫先于处理器）。
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  /** 发送登录/注册验证码（开发环境打印到服务端日志）。 */
  @Post('send-code')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  sendCode(@Body() dto: SendCodeDto): Promise<SendCodeResult> {
    return this.authService.requestCode(dto.email, dto.purpose ?? 'login');
  }

  /** 校验验证码并签发令牌（不存在则自动注册）。 */
  @Post('verify-code')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  verifyCode(@Body() dto: VerifyCodeDto): Promise<AuthResponse> {
    return this.authService.verifyCode(dto.email, dto.code, dto.purpose ?? 'login');
  }

  /** 密码登录（D9）。 */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  login(@Body() dto: LoginDto): Promise<AuthResponse> {
    return this.authService.loginWithPassword(dto.email, dto.password);
  }

  /** 当前登录用户 + 资料 + 目标 + 设置。 */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@CurrentUser() userId: number) {
    return this.usersService.getMe(userId);
  }
}
