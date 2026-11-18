import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { SaveXeroBillSettingsInput, VendorPaymentMethod } from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { IsOptional, IsString, MaxLength, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { VendorBillsXeroService } from './vendor-bills-xero.service';

/** Null is "none"; anything else is checked. */
const GIVEN = (_: object, value: unknown) => value !== null;

/** One optional account a way of paying: every VendorPaymentMethod is named, as the pipe refuses a field it does not know. */
export class XeroBillPaymentAccountsDto implements Partial<Record<VendorPaymentMethod, string>> {
  @IsOptional() @IsString() @MaxLength(80) CHECK?: string;
  @IsOptional() @IsString() @MaxLength(80) ACH?: string;
  @IsOptional() @IsString() @MaxLength(80) CARD?: string;
  @IsOptional() @IsString() @MaxLength(80) CASH?: string;
  @IsOptional() @IsString() @MaxLength(80) OTHER?: string;
}

export class SaveXeroBillSettingsDto implements Required<SaveXeroBillSettingsInput> {
  @ValidateIf(GIVEN) @IsString() @MaxLength(80) purchasesAccountId!: string | null;
  @ValidateNested() @Type(() => XeroBillPaymentAccountsDto) paymentAccounts!: XeroBillPaymentAccountsDto;
}

/**
 * Vendor bills to Xero (2026-11-19, phase 7). A bill's standing is read with
 * the purchasing pages' own permission; sending it, and its payment, needs
 * `purchasing:bills`, which no API key may hold. A company's choices are
 * read and changed with the Xero page's permissions. Each send is one
 * person's press, counted against the organisation's daily ceiling.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/purchasing')
export class VendorBillsXeroController {
  constructor(@Inject(VendorBillsXeroService) private readonly bills: VendorBillsXeroService) {}

  @Get('orders/:orderId/bill/xero')
  @RequirePermissions('purchasing:request')
  standing(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.bills.standing(request.user, orderId);
  }

  @Post('orders/:orderId/bill/xero')
  @RequirePermissions('purchasing:request', 'purchasing:bills')
  @HttpCode(200)
  send(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.bills.send(request.user, orderId);
  }

  @Post('orders/:orderId/bill/xero/payment')
  @RequirePermissions('purchasing:request', 'purchasing:bills')
  @HttpCode(200)
  sendPayment(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.bills.sendPayment(request.user, orderId);
  }

  @Get('xero-bills/:tenantId/settings')
  @RequirePermissions('integrations:read')
  settings(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string) {
    return this.bills.settings(request.user, tenantId);
  }

  @Put('xero-bills/:tenantId/settings')
  @RequirePermissions('integrations:manage')
  saveSettings(@Req() request: AuthenticatedRequest, @Param('tenantId') tenantId: string, @Body() body: SaveXeroBillSettingsDto) {
    return this.bills.saveSettings(request.user, tenantId, body);
  }
}
