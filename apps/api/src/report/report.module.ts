import { Module } from '@nestjs/common';

import { ReportController } from './report.controller';
import { ReportService } from './report.service';

/** 周报模块（二期）。 */
@Module({
  controllers: [ReportController],
  providers: [ReportService],
  exports: [ReportService],
})
export class ReportModule {}
