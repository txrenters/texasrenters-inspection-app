import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PURCHASING_CODE_KINDS, type PurchasingCodeKind, type SavePurchaserCodeInput, type SavePurchasingCodeInput, type XeroOptionMatch } from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { PurchasingCodesService } from './purchasing-codes.service';

export class XeroOptionMatchDto implements Required<XeroOptionMatch> {
  @IsString() @MinLength(1) @MaxLength(80) xeroTenantId!: string;
  @IsString() @MinLength(1) @MaxLength(80) trackingCategoryId!: string;
  @IsString() @MinLength(1) @MaxLength(80) trackingOptionId!: string;
}

/**
 * Every field of the contract input is named: the validation pipe refuses any
 * field it does not know (purchasing-codes.spec.ts runs the pipe).
 */
export class SavePurchasingCodeDto implements Required<SavePurchasingCodeInput> {
  @IsOptional() @IsIn(PURCHASING_CODE_KINDS) kind!: PurchasingCodeKind;
  /** In either case; the service keeps it in capitals and says what shape it must be. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) code!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsBoolean() keepsStock!: boolean;
  @IsOptional() @IsBoolean() active!: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => XeroOptionMatchDto) xero!: XeroOptionMatchDto[];
}

/** Null is "take it away". */
const GIVEN = (_: object, value: unknown) => value !== null;

export class SavePurchaserCodeDto implements Required<SavePurchaserCodeInput> {
  @ValidateIf(GIVEN) @IsString() @MaxLength(40) purchaserCode!: string | null;
}

/**
 * Purchasing codes (2026-11-20, part 1 of the NAV-style requisition): read and
 * changed with `purchasing:codes`, which no API key may hold. Every change is
 * audited; a code is switched off, never removed.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/purchasing')
export class PurchasingCodesController {
  constructor(@Inject(PurchasingCodesService) private readonly codes: PurchasingCodesService) {}

  @Get('codes')
  @RequirePermissions('purchasing:codes')
  list(@Req() request: AuthenticatedRequest) {
    return this.codes.list(request.user);
  }

  @Post('codes')
  @RequirePermissions('purchasing:codes')
  @HttpCode(200)
  create(@Req() request: AuthenticatedRequest, @Body() body: SavePurchasingCodeDto) {
    return this.codes.create(request.user, body);
  }

  @Patch('codes/:codeId')
  @RequirePermissions('purchasing:codes')
  update(@Req() request: AuthenticatedRequest, @Param('codeId', ParseUUIDPipe) codeId: string, @Body() body: SavePurchasingCodeDto) {
    return this.codes.update(request.user, codeId, body);
  }

  @Put('companies/:xeroTenantId/purchaser-code')
  @RequirePermissions('purchasing:codes')
  setPurchaserCode(@Req() request: AuthenticatedRequest, @Param('xeroTenantId') xeroTenantId: string, @Body() body: SavePurchaserCodeDto) {
    return this.codes.setPurchaserCode(request.user, xeroTenantId, body);
  }
}
