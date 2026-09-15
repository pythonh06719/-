import { Module } from '@nestjs/common';

import { MealsModule } from '../meals/meals.module';
import { UsersModule } from '../users/users.module';
import { WeightsModule } from '../weights/weights.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/** 看板模块（US-05）：聚合目标 / 已摄入 / 剩余 / 饮水 / 迷你趋势 / 鼓励语。 */
@Module({
  imports: [UsersModule, MealsModule, WeightsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  // 供 AiModule 的 Agent 工具（get_today_status）复用看板聚合结果
  exports: [DashboardService],
})
export class DashboardModule {}
