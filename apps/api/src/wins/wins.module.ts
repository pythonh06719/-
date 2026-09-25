import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { WinsController } from './wins.controller';
import { WinsService } from './wins.service';

/** 「体重之外的变化」模块（`/api/wins`，R11.4，四期）。 */
@Module({
  imports: [PrismaModule],
  controllers: [WinsController],
  providers: [WinsService],
})
export class WinsModule {}
