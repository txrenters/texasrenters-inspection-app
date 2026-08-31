/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';

import {
  ApiAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedRequest,
} from '../../common/auth';
import { JobberClient } from './jobber.client';
import {
  JobberIgnoreLinkDto,
  JobberLinkPropertyDto,
  JobberLinkQueueQueryDto,
  JobberVisitImportQueryDto,
} from './jobber.dto';
import { JobberError } from './jobber.errors';
import { JobberMappingService } from './jobber.mapping.service';
import { JobberOAuthService } from './jobber.oauth.service';
import { JobberService } from './jobber.service';
import { JobberSyncWorker } from '../../workers/jobber-sync/jobber-sync.worker';

@ApiTags('Jobber integration')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller(['integrations/jobber', 'admin/integrations/jobber'])
export class JobberIntegrationController {
  constructor(
    private readonly service: JobberService,
    private readonly oauth: JobberOAuthService,
    private readonly client: JobberClient,
    private readonly mapping: JobberMappingService,
    private readonly sync: JobberSyncWorker,
  ) {}

  /** What the console shows on the integrations page. Never returns tokens. */
  @Get('connection')
  @RequirePermissions('integrations:read')
  connection(@Req() request: AuthenticatedRequest) {
    return this.service.describeConnection(request.user.organizationId);
  }

  /**
   * Starts consent. Returns the URL rather than redirecting, because the caller
   * is the console's fetch layer — a 302 here would be followed by the fetch
   * and land Jobber's login page inside an XHR response.
   */
  @Post('oauth/authorize')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  authorize(@Req() request: AuthenticatedRequest) {
    return {
      authorizationUrl: this.oauth.buildAuthorizationUrl({
        organizationId: request.user.organizationId,
        userId: request.user.id,
      }),
    };
  }

  @Post('disconnect')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  async disconnect(@Req() request: AuthenticatedRequest) {
    return this.service.disconnect(request.user.organizationId);
  }

  /**
   * Runs the pull now, for the caller's own organization.
   *
   * Scoped to `request.user.organizationId` rather than taking one, so this
   * cannot be pointed at another tenant's calendar. Awaited rather than queued:
   * an administrator pressing sync wants the counts, and the run is bounded by
   * the window and the page cap.
   */
  @Post('sync')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  runSync(@Req() request: AuthenticatedRequest) {
    return this.sync.run(request.user.organizationId);
  }

  /**
   * Jobber properties nobody has been able to tie to one of ours.
   *
   * This is the queue the whole mapping layer exists to produce: until a row
   * here is resolved, every visit at that property is held rather than guessed
   * at.
   */
  @Get('property-links/queue')
  @RequirePermissions('integrations:read')
  queue(@Req() request: AuthenticatedRequest, @Query() query: JobberLinkQueueQueryDto) {
    return this.mapping.queue(request.user, query.limit ?? 50);
  }

  /** Visits that did not become inspections, and why. */
  @Get('visit-imports')
  @RequirePermissions('integrations:read')
  visitImports(@Req() request: AuthenticatedRequest, @Query() query: JobberVisitImportQueryDto) {
    return this.mapping.visitImports(request.user, {
      status: query.status as never,
      limit: query.limit,
    });
  }

  @Post('property-links/:linkId/link')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  link(
    @Req() request: AuthenticatedRequest,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Body() body: JobberLinkPropertyDto,
  ) {
    return this.mapping.link(request.user, linkId, body);
  }

  @Post('property-links/:linkId/ignore')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  ignore(
    @Req() request: AuthenticatedRequest,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Body() body: JobberIgnoreLinkDto,
  ) {
    return this.mapping.ignore(request.user, linkId, body.reason);
  }
}

/**
 * The OAuth callback, reached by a browser redirect from Jobber.
 *
 * Deliberately unguarded: the caller is the admin's browser following Jobber's
 * redirect, carrying no session and no API key. What authorizes it is the
 * sealed `state` parameter, which only this backend can have produced — see
 * JobberOAuthService.
 */
@ApiTags('Jobber integration')
@Controller('integrations/jobber/oauth')
export class JobberOAuthCallbackController {
  constructor(private readonly service: JobberService) {}

  @Get('callback')
  @ApiExcludeEndpoint()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  // Jobber's redirect puts the authorization code in the query string, which
  // browsers keep in history and referrers. Telling the page not to send a
  // referrer keeps the code from leaking to anything it links to.
  @Header('referrer-policy', 'no-referrer')
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    if (error) return page('Jobber authorization was cancelled.', 'You can close this tab.');
    if (!code) return page('Jobber did not return an authorization code.', 'Start the connection again from the console.');
    try {
      const account = await this.service.completeAuthorization({ code, state });
      return page(
        'Jobber is connected.',
        `Scheduling will sync from ${escapeHtml(account.name)}. You can close this tab.`,
      );
    } catch (caught) {
      // Only our own sanitized message is rendered. Jobber's error bodies echo
      // the request, which on the token endpoint carries the client secret.
      const message =
        caught instanceof JobberError ? caught.message : 'The Jobber connection could not be completed.';
      return page('Jobber was not connected.', escapeHtml(message));
    }
  }
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  );

/** A terminal page for a tab the admin is about to close. No styling worth a stylesheet. */
const page = (title: string, detail: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem"><h1 style="font-size:1.25rem;margin:0 0 .5rem">${escapeHtml(title)}</h1><p style="margin:0;color:#555">${detail}</p></body></html>`;
