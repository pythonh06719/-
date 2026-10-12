import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * 鉴权限流守卫（`/auth/verify-code` 与 `/auth/login` **局部**挂载）。
 *
 * 为什么不用 Nest 默认的 IP 计数键：
 * 1. **换 IP 即绕过**：默认键下攻击者从任意地址盲猜受害者的验证码 / 密码，计数形同虚设
 *    （上线前全检 F-002 / F-003：这两条路由此前零限流，是唯一可远程完全攻破账号的路径）；
 * 2. **NAT 互踩**：同一公司 / 学校出口 IP 下的多个用户共享一个桶、互相误伤 ——
 *    AI 路由的 `UserThrottlerGuard` 已因同一理由改用用户维度键。
 *
 * 本守卫改用 **email + IP 复合键**，并按路由路径分桶（verify-code 与 login 互不占用配额）：
 * - `email` 主维度：把「对同一个目标的爆破」锁死在 5 次 / 分钟，换 IP 无用；
 * - `ip` 次维度：同一邮箱在不同 IP 上的尝试各自计数，避免单 IP 打满封掉合法用户的其它入口；
 * - 请求体缺 email（守卫先于校验管道执行，可能拿到畸形请求体）→ 回退纯 IP 键，兜住垃圾流量。
 *
 * ⚠️ 与全局 `APP_GUARD` 的区别：只挂这两条路由，**不引入全站共享限流桶** ——
 *    Render 反代下全局 IP 键会让所有用户共用一个出口 IP = 共用一个桶，
 *    攻击者打满即全站 429（「修了暴力破解、装上一键 DoS 开关」，F-007）。
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  /** 覆写计数键：`auth:<路径>:<email 小写>:<ip>`，缺 email 时退化为 `auth:<路径>:ip:<ip>`。 */
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const path = typeof req.path === 'string' && req.path.length > 0 ? req.path : 'unknown-route';
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const ip = typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : 'unknown-ip';
    return email.length > 0 ? `auth:${path}:${email}:${ip}` : `auth:${path}:ip:${ip}`;
  }
}
