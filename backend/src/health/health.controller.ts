import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DatabaseHealthService } from '../database/database-health.service';
import { PrismaService } from '../database/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabaseHealthService) private readonly database: DatabaseHealthService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}
  @Get() health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
  // `providers` used to be reported here from the vertical-slice stack's own
  // diagnostics, which only ever described the mock providers — it said nothing
  // about the transcription or analysis credentials actually in use. Readiness
  // now speaks only for the database, which it can answer honestly.
  @Get('readiness') readiness() {
    const database = this.prisma.readiness();
    return { status: database.ready ? 'ready' : 'not_ready', database };
  }
  @Get('database') databaseReadiness() {
    return this.database.check();
  }
}
