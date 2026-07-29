import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { VerticalSliceService } from '../vertical-slice/vertical-slice.service';
import { DatabaseHealthService } from '../database/database-health.service';
import { PrismaService } from '../database/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    // The vertical-slice stack is registered only outside production (see
    // app.module.ts). Injecting it unconditionally made the production build
    // unbootable, so it is optional and its diagnostics are simply omitted.
    @Optional()
    @Inject(VerticalSliceService)
    private readonly service: VerticalSliceService | undefined,
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
      ...(this.service ? { providers: this.service.diagnostics() } : {}),
    };
  }
  @Get('database') databaseReadiness() {
    return this.database.check();
  }
}
