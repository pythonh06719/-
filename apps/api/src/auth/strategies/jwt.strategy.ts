import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { getAppConfig } from '../../config/app-config';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { ApiException } from '../../common/exceptions/api.exception';
import type { RequestUser } from '../../common/decorators/current-user';
import { PrismaService } from '../../prisma/prisma.service';

/** JWT 载荷（`sub` = `userId`，ARCHITECTURE §1.7）。 */
export interface JwtPayload {
  /** 用户 id */
  sub: number;
  /** 邮箱 */
  email: string;
  /** 签发时间 */
  iat?: number;
  /** 过期时间 */
  exp?: number;
}

/**
 * passport-jwt 策略：校验 `Authorization: Bearer <accessToken>`，
 * 校验通过后返回归一化的 `{ userId, email }`（挂到 `req.user`）。
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(private readonly prisma: PrismaService) {
    const config = getAppConfig();
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.jwtSecret,
    });
  }

  /**
   * 校验已验签的载荷，并**确认用户仍存在且未被停用**（三期 QA BUG-P3-3 + 上线前全检 F-004）。
   *
   * 背景：账号硬删除（R10.4）后旧 JWT 依然验签通过，此前不再查库，
   * 导致后续带 FK 的查询抛 Prisma 违例 → 500。这里在鉴权层统一根治：
   * `sub` 对应用户不存在 → 401 `E_AUTH_INVALID_TOKEN`（不泄露存在性差异）。
   * `users.service getMe` 里的同款检查保留（双保险）。
   *
   * 停用检查（F-004）：`status='disabled'` 的账号此前**旧 token 仍可用到过期**（最长 2h），
   * 停用形同虚设。现按请求校验状态 → 403 `E_AUTH_USER_DISABLED`，与密码/验证码登录口径一致。
   * ⚠️ 「登出即失效 / 令牌吊销」仍需服务端令牌版本号或 refresh 轮换（未实现，见 F-004 剩余项）。
   */
  async validate(payload: JwtPayload): Promise<RequestUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true },
    });
    if (user === null) {
      throw new ApiException(401, ERROR_CODES.AUTH_INVALID_TOKEN, '登录状态已失效，请重新登录');
    }
    if (user.status === 'disabled') {
      throw new ApiException(403, ERROR_CODES.AUTH_USER_DISABLED, '该账号已停用，如有疑问请联系我们');
    }
    return { userId: user.id, email: payload.email };
  }
}
