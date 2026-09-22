import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module';
import { WeightsController } from './weights.controller';
import { WeightsService } from './weights.service';

/**
 * 体重模块（R7.1 / R7.2）。导出 `WeightsService` 供看板聚合迷你趋势。
 *
 * 引入 `UsersModule`：R2.7 的目标达成进度需要复用 `/profile` 的「资料 + 目标 + 引擎重算」
 * 链路取 `etaWeeks` / `tdee`（`UsersModule` 不反向依赖本模块，无循环）。
 */
@Module({
  imports: [UsersModule],
  controllers: [WeightsController],
  providers: [WeightsService],
  exports: [WeightsService],
})
export class WeightsModule {}
