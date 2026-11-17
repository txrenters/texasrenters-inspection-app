import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { SaveExcelSyncInput } from '@texasrenters/shared';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../../common/auth';
import { ApplicationError } from '../../common/errors';
import { withTenant } from '../../database/tenant-context';
import { ExcelSyncService } from './excel-sync.service';
import { MicrosoftAuthService } from './microsoft-auth.service';

/** Every field of `SaveExcelSyncInput`: the validation pipe refuses any other. */
export class SaveExcelSyncDto implements Required<SaveExcelSyncInput> {
  @IsOptional() @IsString() @MaxLength(2000) shareUrl!: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate!: string;
  @IsOptional() @IsBoolean() enabled!: boolean;
}

/**
 * Actual vs Budget's workbook (2026-11-17): the office's Microsoft account,
 * the workbook's link and the sync's switch. Read with `invoices:read`,
 * changed with `invoices:manage`, as the rest of Actual vs Budget.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/actual-vs-budget/excel')
export class ExcelSyncController {
  constructor(@Inject(ExcelSyncService) private readonly excel: ExcelSyncService) {}

  @Get()
  @RequirePermissions('invoices:read')
  view(@Req() request: AuthenticatedRequest) {
    return this.excel.view(request.user);
  }

  /** Where to send the person to sign in to Microsoft: an address, not a redirect, so the page can open it in a tab. */
  @Post('connect')
  @HttpCode(200)
  @RequirePermissions('invoices:manage')
  connect(@Req() request: AuthenticatedRequest) {
    return this.excel.connectUrl(request.user);
  }

  @Put()
  @RequirePermissions('invoices:manage')
  save(@Req() request: AuthenticatedRequest, @Body() body: SaveExcelSyncDto) {
    return this.excel.save(request.user, body);
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermissions('invoices:manage')
  syncNow(@Req() request: AuthenticatedRequest) {
    return this.excel.syncNow(request.user);
  }

  /** Put right the Text format the console once gave its cells, so the office's formulas work there -- with the sync on or off. */
  @Post('formulas')
  @HttpCode(200)
  @RequirePermissions('invoices:manage')
  repairFormulas(@Req() request: AuthenticatedRequest) {
    return this.excel.repairNow(request.user);
  }

  @Delete('connection')
  @HttpCode(200)
  @RequirePermissions('invoices:manage')
  disconnect(@Req() request: AuthenticatedRequest) {
    return this.excel.disconnect(request.user);
  }
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const page = (title: string, detail: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
  `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2933}h1{font-size:1.25rem}</style></head>` +
  `<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;

/**
 * Where Microsoft sends the person back. No guard on purpose: the sealed,
 * ten-minute state is what says which office and who, as Xero's callback.
 */
@ApiTags('Administrator application')
@Controller('admin/actual-vs-budget/excel')
export class ExcelSyncCallbackController {
  constructor(
    @Inject(ExcelSyncService) private readonly excel: ExcelSyncService,
    @Inject(MicrosoftAuthService) private readonly auth: MicrosoftAuthService,
  ) {}

  @Get('callback')
  @ApiExcludeEndpoint()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  @Header('referrer-policy', 'no-referrer')
  async callback(@Query() query: { code?: string; state?: string; error?: string; error_description?: string }) {
    if (query.error)
      return page('Microsoft was not connected', query.error === 'access_denied' ? 'The sign-in was cancelled. Start it again from Actual vs Budget.' : 'Microsoft refused the sign-in. Start it again from Actual vs Budget.');
    try {
      const state = this.auth.readState(query.state);
      const account = await withTenant(state.organizationId, () => this.excel.completeConnection(query.code, query.state));
      return page('Microsoft is connected', `${account.email ?? 'The account'} now keeps the Actual vs Budget workbook in step. You can close this tab.`);
    } catch (error) {
      return page('Microsoft was not connected', error instanceof ApplicationError ? error.message : 'Something went wrong. Start again from Actual vs Budget.');
    }
  }
}
