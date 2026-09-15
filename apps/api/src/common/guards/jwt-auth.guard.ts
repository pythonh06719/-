import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { ERROR_CODES } from '../constants/error-codes';
import { ApiException } from '../exceptions/api.exception';

import type { RequestUser } from '../decorators/current-user';

/**
 * JWT 鉴权守卫（ARCHITECTURE §1.7 / TC-43）。
 *
 * 校验 `Authorization: Bearer <accessToken>`：
 * - 未携带 / 伪造 / 过期 → 401 `E_AUTH_UNAUTHORIZED`，不返回任何业务数据；
 * - 通过 → 将 `{ userId, email }` 挂到 `req.user`，供 `@CurrentUser()` 消费。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  /**
   * 覆写默认处理逻辑，统一抛出带错误码的业务异常。
   *
   * 策略层（`jwt.strategy validate`）抛出的 `ApiException`（如账号已删除 →
   * `E_AUTH_INVALID_TOKEN`，三期 QA BUG-P3-3）**原样透传**，不吞码。
   */
  override handleRequest<TUser = RequestUser>(
    error: unknown,
    user: TUser | false,
    info: unknown,
  ): TUser {
    if (error instanceof ApiException) {
      throw error;
    }
    if (error || !user) {
      const expired = info instanceof Error && /expired/i.test(info.message);
      throw new ApiException(
        401,
        ERROR_CODES.AUTH_UNAUTHORIZED,
        expired ? '登录已过期，请重新登录' : '请先登录',
      );
    }
    return user;
  }

  /** 保留基类行为（显式声明以便阅读）。 */
  override canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }
}
