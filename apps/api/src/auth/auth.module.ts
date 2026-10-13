import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { getAppConfig } from '../config/app-config';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * 鉴权模块：JWT 签发（`@nestjs/jwt`）+ 校验（`passport-jwt`）。
 */
@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      useFactory: () => {
        const config = getAppConfig();
        return {
          secret: config.jwtSecret,
          // @nestjs/jwt@12 经 @types/jsonwebtoken@9 把 `expiresIn` 收紧为
          // `number | StringValue`（ms 格式字面量联合）；而配置值来自环境变量
          // （运行时字符串，默认 '2h'），jsonwebtoken 运行时接受任意 ms 格式串。
          // 窄化断言落在唯一使用点，配置层保持「env 字符串」的诚实类型。
          signOptions: { expiresIn: config.jwtExpiresIn } as JwtSignOptions,
        };
      },
    }),
    UsersModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
