import { Controller, Get } from '@nestjs/common';

import type { HealthResponse } from '@qsh/shared-types';

/** 健康检查（`GET /api/health`），无需鉴权。 */
@Controller('health')
export class HealthController {
  /** 返回服务状态与服务端时间（ISO8601 UTC）。 */
  @Get()
  check(): HealthResponse {
    return { status: 'ok', time: new Date().toISOString() };
  }
}
