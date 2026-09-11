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

  /**
   * Declared before `:token` so the literal segment wins the match regardless of
   * how the router orders same-length patterns.
   */
  @Get('comparison/:token')
  @Header('Cache-Control', 'private, no-store')
  comparisonReport(@Param('token') token: string) {
    return this.shares.publicComparisonReport(token);
  }

  @Get(':token')
  @Header('Cache-Control', 'private, no-store')
  report(@Param('token') token: string) {
    return this.shares.publicReport(token);
  }

  /**
   * `w` requests a width-limited copy (see ALLOWED_PHOTO_WIDTHS); anything else
   * serves the original. Phone photos are several megabytes each, so the report
   * always asks for a bounded width.
   *
   * The CORP override is what makes these bytes displayable at all. Helmet's
   * default is `same-origin`, and the report page is served from the web app's
   * domain while the photographs come from the API's — so every `<img>` on a
   * shared report was blocked by the browser and rendered as its alt text, even
   * though the request itself returned 200 with the image. It is the only
   * endpoint that needs this: the console never embeds a cross-origin URL, it
   * fetches the bytes with credentials and renders a blob (see LazyPhoto), and
   * CORP does not apply to that.
   *
   * Relaxing it is safe precisely here — the response is public by design. The
   * unguessable share token is the credential, the photo is already restricted
   * to reviewed, homeowner-visible material, and no cookie is involved, so
   * embedding reveals nothing a holder of the link could not already open.
   */
  @Get(':token/photos/:photoId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
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
