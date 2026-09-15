import { randomInt } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { compare, hash } from 'bcryptjs';

import type { AuthResponse, User, VerificationPurpose } from '@qsh/shared-types';

import { getAppConfig, parseDurationSeconds } from '../config/app-config';
import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { toUser } from '../common/mappers/entity.mapper';
import { PrismaService } from '../prisma/prisma.service';

/** 验证码哈希成本因子（验证码为短生命周期低熵串，取 10 兼顾安全与响应速度）。 */
const CODE_HASH_COST = 10;

/** `/auth/send-code` 的返回体。 */
export interface SendCodeResult {
  /** 固定 `true`（无论邮箱是否存在，避免账号枚举） */
  sent: true;
  /** 邮箱 */
  email: string;
  /** 验证码剩余有效秒数 */
  expiresInSeconds: number;
}

/**
 * 鉴权服务（R1.1 / R1.6 / R1.7）。
 *
 * - 邮箱 + 6 位验证码：验证码**存 hash**、5 分钟有效、**一次性消费**；不存在则自动注册；
 * - 密码登录（bcrypt，cost=12）作为共存路径（D9）；
 * - 签发 JWT：payload `{ sub: userId, email }`。
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * 发送验证码。**开发环境把验证码打到服务端日志**（D4，不接真实 SMTP）。
   *
   * 同一 `(email, purpose)` 的未消费旧验证码会被立即置为已消费，保证「仅最新一条有效」。
   */
  async requestCode(email: string, purpose: VerificationPurpose = 'login'): Promise<SendCodeResult> {
    const config = getAppConfig();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = await hash(code, CODE_HASH_COST);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.verificationCodeTtlSeconds * 1000).toISOString();

    await this.prisma.$transaction([
      this.prisma.authVerificationCode.updateMany({
        where: { email, purpose, consumedAt: null },
        data: { consumedAt: now.toISOString() },
      }),
      this.prisma.authVerificationCode.create({ data: { email, codeHash, purpose, expiresAt } }),
    ]);

    // 生产环境默认不打印验证码（安全）；仅当显式开启 AUTH_LOG_CODE 时输出，
    // 用于尚无 SMTP 的演示/预发环境（见 app-config 注释）
    if (config.nodeEnv !== 'production' || config.allowLogVerificationCode) {
      this.logger.log(
        `[验证码] ${email} → ${code}（${config.verificationCodeTtlSeconds} 秒内有效，单次使用）`,
      );
    }

    return { sent: true, email, expiresInSeconds: config.verificationCodeTtlSeconds };
  }

  /**
   * 校验验证码并签发令牌；**邮箱不存在时自动注册**（R1.1）。
   */
  async verifyCode(
    email: string,
    code: string,
    purpose: VerificationPurpose = 'login',
  ): Promise<AuthResponse> {
    const record = await this.prisma.authVerificationCode.findFirst({
      where: { email, purpose, consumedAt: null },
      orderBy: { id: 'desc' },
    });

    if (!record) {
      throw new ApiException(400, ERROR_CODES.AUTH_CODE_INVALID, '验证码不正确，请重新获取');
    }

    if (new Date(record.expiresAt).getTime() < Date.now()) {
      throw new ApiException(400, ERROR_CODES.AUTH_CODE_EXPIRED, '验证码已过期，请重新获取');
    }

    const matched = await compare(code, record.codeHash);
    if (!matched) {
      throw new ApiException(400, ERROR_CODES.AUTH_CODE_INVALID, '验证码不正确，请重新获取');
    }

    await this.prisma.authVerificationCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date().toISOString() },
    });

    const nowIso = new Date().toISOString();
    let userRow = await this.prisma.user.findUnique({ where: { email } });

    if (!userRow) {
      userRow = await this.prisma.user.create({ data: { email, emailVerifiedAt: nowIso } });
      // 1:1 扩展表建默认行（settings 立即可用；profile/goal 待引导问卷创建）
      await this.prisma.userSettings.create({ data: { userId: userRow.id } });
    } else if (userRow.emailVerifiedAt === null) {
      userRow = await this.prisma.user.update({
        where: { id: userRow.id },
        data: { emailVerifiedAt: nowIso },
      });
    }

    if (userRow.status === 'disabled') {
      throw new ApiException(403, ERROR_CODES.AUTH_USER_DISABLED, '该账号已停用，如有疑问请联系我们');
    }

    return this.issueSession(userRow.id, userRow.email, toUser(userRow));
  }

  /**
   * 密码登录（R1.6 / D9）。`password_hash IS NULL` 的纯验证码用户不可用此路径。
   */
  async loginWithPassword(email: string, password: string): Promise<AuthResponse> {
    const userRow = await this.prisma.user.findUnique({ where: { email } });
    const invalid = new ApiException(401, ERROR_CODES.AUTH_UNAUTHORIZED, '邮箱或密码不正确');

    if (!userRow || !userRow.passwordHash) {
      throw invalid;
    }
    if (userRow.status === 'disabled') {
      throw new ApiException(403, ERROR_CODES.AUTH_USER_DISABLED, '该账号已停用，如有疑问请联系我们');
    }

    const matched = await compare(password, userRow.passwordHash);
    if (!matched) {
      throw invalid;
    }

    return this.issueSession(userRow.id, userRow.email, toUser(userRow));
  }

  /** 统一签发会话（JWT + 是否已完成引导）。 */
  private async issueSession(userId: number, email: string, user: User): Promise<AuthResponse> {
    const config = getAppConfig();
    const accessToken = await this.jwt.signAsync({ sub: userId, email });
    const profile = await this.prisma.userProfile.findUnique({
      where: { userId },
      select: { onboardingCompletedAt: true },
    });

    return {
      accessToken,
      expiresInSeconds: parseDurationSeconds(config.jwtExpiresIn),
      user,
      onboardingCompleted: Boolean(profile?.onboardingCompletedAt),
    };
  }
}
