/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiAuthGuard,
  RequirePermissions,
  RolesGuard,
  verifyAccessToken,
  type AuthenticatedRequest,
} from '../common/auth';
import { ClientErrorsService } from './client-errors.service';
import { ReportClientErrorsDto } from './client-errors.dto';

/** The first `x-forwarded-for` entry, or the socket address behind no proxy. */
function callerAddress(request: Request) {
  const forwarded = request.header('x-forwarded-for');
  return (forwarded?.split(',')[0]?.trim() || request.ip)?.slice(0, 64);
}

@ApiTags('Client errors')
@Controller('client-errors')
export class ClientErrorsController {
  constructor(private readonly service: ClientErrorsService) {}

  /**
   * Accept a client's error log. **Deliberately unauthenticated.**
   *
   * The reports worth having most are the ones raised before anybody signed in:
   * a failed sign-in, a build whose API address no longer answers, a bundle
   * that cannot reach anything. None of them have a session, so a guard here
   * would leave the log empty in exactly the situation it exists for. The whole
   * afternoon that produced this feature was one of those.
   *
   * What stands in for the guard: every field is length-capped, the batch is
   * capped at the size of the handset's own log, writes are rate limited per
   * install, the payload is redacted again on this side, and nothing read back
   * out is ever executed. A caller can waste rows. It cannot read anything, and
   * it cannot say who it is — identity is taken from the token below, never
   * from the body.
   */
  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Report client-side errors (no authentication required)' })
  async report(@Req() request: Request, @Body() body: ReportClientErrorsDto) {
    // Attributed only if the caller happens to be signed in, and a bad token is
    // not an error here: the report is still worth keeping, just anonymously.
    //
    // The organization stays null even for a signed-in caller. The log is read
    // across tenants by an operator, and filling it in would make the
    // pre-sign-in reports — the ones this exists for — look like a different
    // class of row than the rest.
    const organizationId: string | null = null;
    let authUserId: string | null = null;
    const header = request.header('authorization');
    if (header?.toLowerCase().startsWith('bearer ')) {
      try {
        const claims = await verifyAccessToken(header.slice(7).trim());
        authUserId = claims.sub ?? null;
      } catch {
        // Expired or unreadable. The error is still recorded, unattributed.
      }
    }

    return this.service.report(body, {
      organizationId,
      authUserId,
      ipAddress: callerAddress(request),
    });
  }

  /**
   * Read the log. Operator-only.
   *
   * `system:manage` rather than a tenant permission, and not scoped to one
   * organization, because an unauthenticated report belongs to none — the rows
   * this exists to show would be invisible under a tenant scope.
   */
  @Get()
  @ApiBearerAuth()
  @UseGuards(ApiAuthGuard, RolesGuard)
  @RequirePermissions('system:manage')
  list(
    @Req() _request: AuthenticatedRequest,
    @Query('source') source?: 'MOBILE' | 'CONSOLE',
    @Query('fatalOnly') fatalOnly?: string,
    @Query('search') search?: string,
    @Query('take') take?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.list({
      source: source === 'MOBILE' || source === 'CONSOLE' ? source : undefined,
      fatalOnly: fatalOnly === 'true',
      search: search?.trim() || undefined,
      take: take ? Number(take) : undefined,
      cursor: cursor || undefined,
    });
  }

  @Get('summary')
  @ApiBearerAuth()
  @UseGuards(ApiAuthGuard, RolesGuard)
  @RequirePermissions('system:manage')
  summary() {
    return this.service.summary();
  }
}
