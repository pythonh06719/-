import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { ApiException } from '../exceptions/api.exception';
import { ERROR_CODES } from '../constants/error-codes';

/** 经过 `JwtStrategy.validate()` 归一后的请求用户上下文。 */
export interface RequestUser {
  /** 来自 JWT `sub`（服务端唯一可信的用户标识） */
  userId: number;
  /** JWT 中的邮箱（仅用于展示/日志） */
  email: string;
}

/**
 * `@CurrentUser()` 参数装饰器：**从 JWT 取 `userId`**（ARCHITECTURE §7 K7 / TC-42）。
 *
 * 服务端一律以本装饰器返回的 `userId` 为准，**忽略 body / query 中的任何 `userId` 字段**。
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): number => {
  const request = ctx.switchToHttp().getRequest<{ user?: RequestUser }>();
  const user = request.user;
  if (!user || typeof user.userId !== 'number') {
    throw new ApiException(401, ERROR_CODES.AUTH_UNAUTHORIZED, '请先登录');
  }
  return user.userId;
});
