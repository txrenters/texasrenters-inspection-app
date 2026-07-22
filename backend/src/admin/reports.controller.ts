/* Injection tokens are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ReportShareService } from './report-share.service';

/**
 * Public homeowner-facing reports. Access is capability-based: the unguessable
 * share token an administrator issued IS the credential, so this controller
 * is intentionally unauthenticated. The service only ever returns reviewed,
 * homeowner-safe content for unexpired, unrevoked tokens.
 */
@ApiTags('Public inspection reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly shares: ReportShareService) {}

  @Get(':token')
  @Header('Cache-Control', 'private, no-store')
  report(@Param('token') token: string) {
    return this.shares.publicReport(token);
  }
}
