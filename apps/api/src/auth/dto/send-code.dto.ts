import { IsEmail, IsIn, IsOptional } from 'class-validator';

import type { VerificationPurpose } from '@qsh/shared-types';

/** `POST /api/auth/send-code` 请求体。 */
export class SendCodeDto {
  /** 邮箱 */
  @IsEmail({}, { message: '请输入正确的邮箱地址' })
  email!: string;

  /** 用途（缺省 `login`） */
  @IsOptional()
  @IsIn(['login', 'signup', 'reset'], { message: '验证码用途不正确' })
  purpose?: VerificationPurpose;
}
