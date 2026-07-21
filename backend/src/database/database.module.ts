import { Global, Module } from '@nestjs/common';

import { DatabaseHealthService } from './database-health.service';
import { PrismaService } from './prisma.service';
import { QueryPerformanceContext } from './query-performance.context';

@Global()
@Module({
  providers: [QueryPerformanceContext, PrismaService, DatabaseHealthService],
  exports: [QueryPerformanceContext, PrismaService, DatabaseHealthService],
})
export class DatabaseModule {}
