import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../../common/auth';
import { XeroAuthService } from './xero-auth.service';
import { XeroCheckService } from './xero-check.service';
import { XeroSenderService } from './xero-sender.service';
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

/** Sending on or off. */
export class SetXeroSendingDto {
  @IsBoolean() enabled!: boolean;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A month of invoices to check against Xero (2026-11-10, phase 5): `YYYY-MM`. */
export class XeroCheckMonthDto {
  @Matches(MONTH) month!: string;
}

/**
 * The office's Xero organisations (2026-11-10): seen with `integrations:read`;
 * connected, read again, their accounts chosen, sending turned on or off and
 * disconnected -- one at a time, or the whole sign-in -- with
 * `integrations:manage`, as Jobber is. Only sending writes to Xero, and only
 * while it is on for that organisation.
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
    @Inject(XeroSenderService) private readonly sender: XeroSenderService,
    @Inject(XeroCheckService) private readonly checks: XeroCheckService,
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

  /** Reads one organisation, its accounts, tax rates and invoice reminders again: four calls to it, at most every five minutes. */
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

  /** Sending invoices to one organisation: what was sent, what was refused and why. No call to Xero. */
  @Get('organisations/:tenantId/sending')
  @RequirePermissions('integrations:read')
  sending(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string) {
    return this.sender.view(request.user.organizationId, tenantOf(tenantId));
  }

  /** On only when nothing blocks it. */
  @Put('organisations/:tenantId/sending')
  @RequirePermissions('integrations:manage')
  setSending(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string, @Body() body: SetXeroSendingDto) {
    return this.sender.setEnabled(request.user, tenantOf(tenantId), body.enabled);
  }

  /** "Send now": one run at once, at most once a minute; only changed invoices reach Xero. */
  @Post('organisations/:tenantId/sending/run')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  runSending(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string) {
    return this.sender.runNow(request.user, tenantOf(tenantId));
  }

  /** "Try again": every invoice this organisation refused is due on the next run. */
  @Post('organisations/:tenantId/sending/retry')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  retrySending(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string) {
    return this.sender.retryFailed(request.user, tenantOf(tenantId));
  }

  /** The month's latest check against Xero (2026-11-10, phase 5), from the console's record: no call to Xero. */
  @Get('organisations/:tenantId/check')
  @RequirePermissions('integrations:read')
  check(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string, @Query() query: XeroCheckMonthDto) {
    return this.checks.view(request.user.organizationId, tenantOf(tenantId), query.month);
  }

  /** "Check now": reads the month's invoices from Xero, at most once a minute, and keeps what differs. */
  @Post('organisations/:tenantId/check')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  runCheck(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string, @Body() body: XeroCheckMonthDto) {
    return this.checks.run(request.user, tenantOf(tenantId), body.month);
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
