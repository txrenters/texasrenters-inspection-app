/* Injection tokens are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Controller, Get, Header, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

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

  /**
   * `w` requests a width-limited copy (see ALLOWED_PHOTO_WIDTHS); anything else
   * serves the original. Phone photos are several megabytes each, so the report
   * always asks for a bounded width.
   */
  @Get(':token/photos/:photoId')
  @Header('Cache-Control', 'private, no-store')
  async photo(
    @Param('token') token: string,
    @Param('photoId') photoId: string,
    @Query('w') width: string | undefined,
    @Res() response: Response,
  ) {
    const photo = await this.shares.publicPhoto(token, photoId, width ? Number(width) : undefined);
    response.setHeader('Content-Type', photo.mimeType);
    response.setHeader('Content-Length', photo.bytes.length);
    response.end(photo.bytes);
  }
}
