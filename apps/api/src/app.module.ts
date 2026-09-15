import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthModule } from './auth/auth.module';
import { AiModule } from './ai/ai.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { createValidationPipe } from './common/pipes/validation-pipe.factory';
import { DashboardModule } from './dashboard/dashboard.module';
import { DataModule } from './data/data.module';
import { ExerciseModule } from './exercise/exercise.module';
import { FastingModule } from './fasting/fasting.module';
import { FoodsModule } from './foods/foods.module';
import { HabitsModule } from './habits/habits.module';
import { HealthModule } from './health/health.module';
import { MealsModule } from './meals/meals.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReportModule } from './report/report.module';
import { UsersModule } from './users/users.module';
import { WaterModule } from './water/water.module';
import { WeightsModule } from './weights/weights.module';

/**
 * 应用根模块。
 *
 * ⚠️ 偏离记录：架构 §2 约定在 `main.ts` 注册全局管道 / 拦截器 / 过滤器。
 * 本实现改为通过 `APP_PIPE` / `APP_INTERCEPTOR` / `APP_FILTER` 令牌在根模块注册 ——
 * 语义完全一致，但**同时作用于 e2e 测试**（`Test.createTestingModule` 不会执行 `main.ts`），
 * 保证测试与线上行为对齐。`main.ts` 仍负责 helmet / CORS / 全局前缀 / 优雅关闭。
 *
 * 说明：架构约定用 `@nestjs/config` 的 `ConfigModule` 读 `.env`，但该包当前未安装
 * （工程师不自行 `npm install`，避免并发破坏 lockfile）；此处用 `dotenv`（已在依赖清单）
 * 在 `config/app-config.ts` 内统一加载，语义等价。详见回传的「缺失依赖清单」。
 */
@Module({
  imports: [
    PrismaModule,
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 300,
      },
    ]),
    AuthModule,
    UsersModule,
    FoodsModule,
    MealsModule,
    WeightsModule,
    // 二期（T05）：运动 / 饮水 / 习惯 / 断食 / 周报 / 数据主权
    ExerciseModule,
    WaterModule,
    HabitsModule,
    FastingModule,
    ReportModule,
    DataModule,
    DashboardModule,
    // 三期（T05 三期）：AI 助手（R9.x / R3.7）
    AiModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
