import { Body, Controller, Get, Header, HttpCode, Inject, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../../common/auth';
import { XeroAuthService } from './xero-auth.service';
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

/** Sending on or off. */
export class SetXeroSendingDto {
  @IsBoolean() enabled!: boolean;
}

/**
 * The office's Xero organisation (2026-11-10, phases 1-3 of the Xero plan):
 * seen with `integrations:read`; connected, read again, its accounts chosen,
 * sending turned on or off and disconnected with `integrations:manage`, as
 * Jobber is. Only sending writes to Xero, and only while it is on.
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

  /** Reads the organisation, its accounts, tax rates and invoice reminders again: four calls, at most every five minutes. */
  @Post('read')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  read(@Req() request: AuthenticatedRequest) {
    return this.xero.read(request.user.organizationId);
  }

  @Post('disconnect')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  disconnect(@Req() request: AuthenticatedRequest) {
    return this.xero.disconnect(request.user);
  }

  /** What goes where (phase 2): read from the console's own copy, never from Xero. */
  @Get('settings')
  @RequirePermissions('integrations:read')
  readSettings(@Req() request: AuthenticatedRequest) {
    return this.settings.read(request.user.organizationId);
  }

  @Put('settings')
  @RequirePermissions('integrations:manage')
  saveSettings(@Req() request: AuthenticatedRequest, @Body() body: SaveXeroSettingsDto) {
    return this.settings.save(request.user, body as Parameters<XeroSettingsService['save']>[1]);
  }

  /** Sending invoices (phase 3): what was sent, what was refused and why. No call to Xero. */
  @Get('sending')
  @RequirePermissions('integrations:read')
  sending(@Req() request: AuthenticatedRequest) {
    return this.sender.view(request.user.organizationId);
  }

  /** On only when nothing blocks it. */
  @Put('sending')
  @RequirePermissions('integrations:manage')
  setSending(@Req() request: AuthenticatedRequest, @Body() body: SetXeroSendingDto) {
    return this.sender.setEnabled(request.user, body.enabled);
  }

  /** "Send now": one run at once, at most once a minute; only changed invoices reach Xero. */
  @Post('sending/run')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  runSending(@Req() request: AuthenticatedRequest) {
    return this.sender.runNow(request.user);
  }

  /** "Try again": every refused invoice is due on the next run. */
  @Post('sending/retry')
  @HttpCode(200)
  @RequirePermissions('integrations:manage')
  retrySending(@Req() request: AuthenticatedRequest) {
    return this.sender.retryFailed(request.user);
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
      const organisation = await this.xero.completeAuthorization({ code, state });
      return page('Xero is connected.', `The console now reads ${escapeHtml(organisation.name)}. You can close this tab.`);
    } catch (caught) {
      return page('Xero was not connected.', escapeHtml(caught instanceof XeroError ? caught.message : 'The connection could not be completed.'));
    }
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

const page = (title: string, detail: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem"><h1 style="font-size:1.25rem;margin:0 0 .5rem">${escapeHtml(title)}</h1><p style="margin:0;color:#555">${detail}</p></body></html>`;
