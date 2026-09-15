import { Module } from '@nestjs/common';

import { BudgetService } from './budget.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * 用户模块：引导问卷 + 基础数据修改重算（R1.3 / R1.4）。
 *
 * 导出 `UsersService` / `BudgetService`，供鉴权（`/auth/me`）与看板复用。
 */
@Module({
  controllers: [UsersController],
  providers: [UsersService, BudgetService],
  exports: [UsersService, BudgetService],
})
export class UsersModule {}
