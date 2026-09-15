import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/** 健康检查模块（`GET /api/health`）。 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
