import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import type { RequestUser } from '../decorators/current-user';

/**
 * 用户维度限流守卫（ARCHITECTURE §1.7 成本防线）。
 *
 * Nest 默认的 `ThrottlerGuard` 以 **IP** 作为计数键 —— 这对 AI 路由不安全：
 * 同一公司 / 学校 NAT 后的多个用户会共享配额（互相误伤）；而攻击者换 IP 即可绕过。
 * AI 路由**每次调用都烧 token**，因此改为按**登录用户**计数。
 *
 * 计数键策略：
 * - 已通过 `JwtAuthGuard` 鉴权（`req.user.userId` 存在）→ `user:<userId>`；
 * - 兜底（理论上不会走到，因为 AI 路由的守卫顺序是 JwtAuthGuard 在前）→ `ip:<ip>`，
 *   保证守卫单独使用时仍可用。
 *
 * ⚠️ 使用前提：必须与 `JwtAuthGuard` **按序**挂在同一路由
 * （`@UseGuards(JwtAuthGuard, UserThrottlerGuard)`），否则读不到 `req.user`。
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  /** 覆写计数键：优先用 JWT 中的 `userId`，回退到 IP（见类注释）。 */
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as RequestUser | undefined;
    if (user !== undefined && typeof user.userId === 'number') {
      return `user:${user.userId}`;
    }
    const ip = req.ip;
    return `ip:${typeof ip === 'string' && ip.length > 0 ? ip : 'unknown'}`;
  }
}
