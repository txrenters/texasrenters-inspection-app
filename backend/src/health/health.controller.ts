import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { VerticalSliceService } from '../vertical-slice/vertical-slice.service';
import { DatabaseHealthService } from '../database/database-health.service';
import { PrismaService } from '../database/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(VerticalSliceService) private readonly service: VerticalSliceService,
    @Inject(DatabaseHealthService) private readonly database: DatabaseHealthService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}
  @Get() health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
  @Get('readiness') readiness() {
    const database = this.prisma.readiness();
    return {
      status: database.ready ? 'ready' : 'not_ready',
      database,
      providers: this.service.diagnostics(),
    };
  }
  @Get('database') databaseReadiness() {
    return this.database.check();
  }
}
