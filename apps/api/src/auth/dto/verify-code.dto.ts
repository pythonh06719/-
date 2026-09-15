import { IsEmail, IsIn, IsOptional, Matches } from 'class-validator';

import type { VerificationPurpose } from '@qsh/shared-types';

/** `POST /api/auth/verify-code` 请求体。 */
export class VerifyCodeDto {
  /** 邮箱 */
  @IsEmail({}, { message: '请输入正确的邮箱地址' })
  email!: string;

  /** 6 位数字验证码 */
  @Matches(/^\d{6}$/, { message: '验证码为 6 位数字' })
  code!: string;

  /** 用途（缺省 `login`） */
  @IsOptional()
  @IsIn(['login', 'signup', 'reset'], { message: '验证码用途不正确' })
  purpose?: VerificationPurpose;
}
