import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../../common/auth';
import { XeroAuthService } from './xero-auth.service';
import { XeroSettingsService } from './xero-settings.service';
import { XeroError } from './xero.errors';
import { XeroService } from './xero.service';

/** The office's choices for sending to Xero; each account is checked against the last read of Xero's. */
export class SaveXeroSettingsDto {
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) sendFrom!: string | null;
  @IsOptional() @IsString() @MaxLength(64) salesAccountId!: string | null;
  @IsOptional() @IsString() @MaxLength(64) salesTaxType!: string | null;
  /** Product or service name key to Xero account id. */
  @IsObject() salesAccounts!: Record<string, string>;
  /** Payment method to Xero account id. */
  @IsObject() paymentAccounts!: Record<string, string>;
  @IsOptional() @IsISO8601() expectedUpdatedAt!: string | null;
}

/** Xero's ids for organisations are GUIDs; anything else names none of the office's. */
const tenantOf = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new XeroError('That is not one of the office’s Xero organisations.', 'XERO_ORGANISATION_UNKNOWN', 404);
  return value;
};

/**
 * The office's Xero organisations (2026-11-10): seen with `integrations:read`;
 * connected, read again, their accounts chosen and disconnected -- one at a
 * time, or the whole sign-in -- with `integrations:manage`, as Jobber is.
 * Nothing here writes to Xero.
 */
@ApiTags('Xero integration')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/integrations/xero')
export class XeroController {
  constructor(
    @Inject(XeroService) private readonly xero: XeroService,
    @Inject(XeroAuthService) private readonly auth: XeroAuthService,
    @Inject(XeroSettingsService) private readonly settings: XeroSettingsService,
  ) {}

  /** What the page shows. Never a token. */
  @Get('connection')
  @RequirePermissions('integrations:read')
  connection(@Req() request: AuthenticatedRequest) {
    return this.xero.describe(request.user.organizationId);
  }

  /** Where to sign in to Xero. A URL, not a redirect: the console's fetch would follow a 302 into an XHR. */
  @Post('oauth/authorize')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  authorize(@Req() request: AuthenticatedRequest) {
    return { authorizationUrl: this.auth.authorizationUrl({ organizationId: request.user.organizationId, userId: request.user.id }) };
  }

  /** Reads one organisation, its accounts and tax rates again: three calls to it, at most every five minutes. */
  @Post('organisations/:tenantId/read')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  read(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string) {
    return this.xero.read(request.user.organizationId, tenantOf(tenantId));
  }

  /** Ends the link to one organisation; the others stay connected. */
  @Post('organisations/:tenantId/disconnect')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  disconnectOrganisation(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string) {
    return this.xero.disconnectOrganisation(request.user, tenantOf(tenantId));
  }

  /** Ends the whole sign-in, and every organisation's link with it. */
  @Post('disconnect')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  disconnect(@Req() request: AuthenticatedRequest) {
    return this.xero.disconnect(request.user);
  }

  /** What goes where in one organisation: read from the console's own copy, never from Xero. */
  @Get('organisations/:tenantId/settings')
  @RequirePermissions('integrations:read')
  readSettings(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string) {
    return this.settings.read(request.user.organizationId, tenantOf(tenantId));
  }

  @Put('organisations/:tenantId/settings')
  @RequirePermissions('integrations:manage')
  saveSettings(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string, @Body() body: SaveXeroSettingsDto) {
    return this.settings.save(request.user, tenantOf(tenantId), body as Parameters<XeroSettingsService['save']>[2]);
  }
}

/**
 * Where Xero sends the browser back after sign-in. Unguarded on purpose: it
 * carries no session. What authorizes it is the sealed `state` only this
 * server can have made.
 */
@ApiTags('Xero integration')
@Controller('integrations/xero/oauth')
export class XeroOAuthCallbackController {
  constructor(@Inject(XeroService) private readonly xero: XeroService) {}

  @Get('callback')
  @ApiExcludeEndpoint()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  // The code is in the address: never send it on as a referrer.
  @Header('referrer-policy', 'no-referrer')
  async callback(@Query('code') code?: string, @Query('state') state?: string, @Query('error') error?: string) {
    if (error) return page('Xero was not connected.', 'The sign-in was cancelled. You can close this tab.');
    if (!code) return page('Xero did not send a sign-in code.', 'Start again from the console.');
    try {
      const { names } = await this.xero.completeAuthorization({ code, state });
      return page(
        'Xero is connected.',
        `The console now reads ${escapeHtml(names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]!)}. You can close this tab.`,
      );
    } catch (caught) {
      return page('Xero was not connected.', escapeHtml(caught instanceof XeroError ? caught.message : 'The connection could not be completed.'));
    }
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

const page = (title: string, detail: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem"><h1 style="font-size:1.25rem;margin:0 0 .5rem">${escapeHtml(title)}</h1><p style="margin:0;color:#555">${detail}</p></body></html>`;
