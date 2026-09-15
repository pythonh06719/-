import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/** `POST /api/auth/login` 请求体（密码登录；`password_hash IS NULL` 时该路径不可用，D9）。 */
export class LoginDto {
  /** 邮箱 */
  @IsEmail({}, { message: '请输入正确的邮箱地址' })
  email!: string;

  /** 密码（8–72 字符） */
  @IsString({ message: '请输入密码' })
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(72, { message: '密码最多 72 位' })
  password!: string;
}
