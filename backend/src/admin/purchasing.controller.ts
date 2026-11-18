import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  MOST_REQUISITION_LINES,
  MOST_REQUISITION_QUOTES,
  MOST_STOCK_QUANTITY,
  MOST_UNIT_COST_CENTS,
  type RequisitionDecisionInput,
  type RequisitionLineInput,
  type RequisitionQuoteInput,
  type SavePurchasingSettingsInput,
  type SaveRequisitionInput,
} from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { PurchasingService } from './purchasing.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Null is "none"; anything else is checked. The form sends the whole requisition, so every field is there. */
const GIVEN = (_: object, value: unknown) => value !== null;
/** A quote or a limit past this is a typo: $1,000,000.00. */
const MOST_CENTS = 100_000_000;

export class RequisitionLineDto implements Required<RequisitionLineInput> {
  @ValidateIf(GIVEN) @IsUUID() itemId!: string | null;
  @ValidateIf(GIVEN) @IsString() @MaxLength(200) description!: string | null;
  @IsInt() @Min(1) @Max(MOST_STOCK_QUANTITY) quantity!: number;
  @IsInt() @Min(0) @Max(MOST_UNIT_COST_CENTS) estimatedUnitCostCents!: number;
}

export class RequisitionQuoteDto implements Required<RequisitionQuoteInput> {
  @IsUUID() vendorId!: string;
  @IsInt() @Min(0) @Max(MOST_CENTS) totalCents!: number;
  @ValidateIf(GIVEN) @IsString() @MaxLength(80) delivery!: string | null;
  @IsBoolean() chosen!: boolean;
}

/**
 * Every field of each contract input is named in its DTO: the validation pipe
 * refuses any field it does not know (purchasing.spec.ts runs the pipe).
 */
export class SaveRequisitionDto implements Required<SaveRequisitionInput> {
  @ValidateIf(GIVEN) @IsString() @MaxLength(80) xeroTenantId!: string | null;
  @ValidateIf(GIVEN) @Matches(DAY) neededBy!: string | null;
  @ValidateIf(GIVEN) @IsUUID() deliverToPlaceId!: string | null;
  @IsString() @MaxLength(2000) reason!: string;
  @IsArray() @ArrayMaxSize(MOST_REQUISITION_LINES) @ValidateNested({ each: true }) @Type(() => RequisitionLineDto) lines!: RequisitionLineDto[];
  @IsArray() @ArrayMaxSize(MOST_REQUISITION_QUOTES) @ValidateNested({ each: true }) @Type(() => RequisitionQuoteDto) quotes!: RequisitionQuoteDto[];
}

export class RequisitionDecisionDto implements Required<RequisitionDecisionInput> {
  @IsOptional() @IsString() @MaxLength(1000) note!: string | null;
}

export class SavePurchasingSettingsDto implements Required<SavePurchasingSettingsInput> {
  @IsInt() @Min(0) @Max(MOST_CENTS) approvalLimitCents!: number;
  @IsInt() @Min(0) @Max(MOST_REQUISITION_QUOTES) quotesAboveLimit!: number;
}

export class RequisitionListQueryDto {
  @IsOptional() @IsIn(['open', 'closed']) show?: 'open' | 'closed';
}

/**
 * Purchase requisitions (2026-11-19, phase 2). `purchasing:request` opens
 * Purchasing and is on every route; deciding adds `purchasing:approve`, and
 * the limits add `purchasing:approve-any`. No API key may hold any of them.
 * Whose requisition a caller may see or touch, and how much they may approve,
 * is decided in the service.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/purchasing')
export class PurchasingController {
  constructor(@Inject(PurchasingService) private readonly purchasing: PurchasingService) {}

  @Get('requisitions')
  @RequirePermissions('purchasing:request')
  list(@Req() request: AuthenticatedRequest, @Query() query: RequisitionListQueryDto) {
    return this.purchasing.list(request.user, query.show ?? 'open');
  }

  @Get('choices')
  @RequirePermissions('purchasing:request')
  choices(@Req() request: AuthenticatedRequest) {
    return this.purchasing.choices(request.user);
  }

  @Post('requisitions')
  @RequirePermissions('purchasing:request')
  create(@Req() request: AuthenticatedRequest, @Body() body: SaveRequisitionDto) {
    return this.purchasing.create(request.user, body);
  }

  @Get('requisitions/:requisitionId')
  @RequirePermissions('purchasing:request')
  detail(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string) {
    return this.purchasing.detail(request.user, requisitionId);
  }

  @Put('requisitions/:requisitionId')
  @RequirePermissions('purchasing:request')
  update(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Body() body: SaveRequisitionDto) {
    return this.purchasing.update(request.user, requisitionId, body);
  }

  @Post('requisitions/:requisitionId/submit')
  @RequirePermissions('purchasing:request')
  @HttpCode(200)
  submit(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string) {
    return this.purchasing.submit(request.user, requisitionId);
  }

  @Post('requisitions/:requisitionId/cancel')
  @RequirePermissions('purchasing:request')
  @HttpCode(200)
  cancel(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string) {
    return this.purchasing.cancel(request.user, requisitionId);
  }

  @Post('requisitions/:requisitionId/approve')
  @RequirePermissions('purchasing:request', 'purchasing:approve')
  @HttpCode(200)
  approve(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Body() body: RequisitionDecisionDto) {
    return this.purchasing.decide(request.user, requisitionId, 'APPROVED', body);
  }

  @Post('requisitions/:requisitionId/send-back')
  @RequirePermissions('purchasing:request', 'purchasing:approve')
  @HttpCode(200)
  sendBack(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Body() body: RequisitionDecisionDto) {
    return this.purchasing.decide(request.user, requisitionId, 'SENT_BACK', body);
  }

  @Post('requisitions/:requisitionId/reject')
  @RequirePermissions('purchasing:request', 'purchasing:approve')
  @HttpCode(200)
  reject(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Body() body: RequisitionDecisionDto) {
    return this.purchasing.decide(request.user, requisitionId, 'REJECTED', body);
  }

  @Put('settings')
  @RequirePermissions('purchasing:request', 'purchasing:approve', 'purchasing:approve-any')
  saveSettings(@Req() request: AuthenticatedRequest, @Body() body: SavePurchasingSettingsDto) {
    return this.purchasing.saveSettings(request.user, body);
  }
}
