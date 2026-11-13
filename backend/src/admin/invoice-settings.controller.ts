import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  InspectionType,
  MAX_BILLING_RULES,
  MAX_PRODUCT_PRICE_CENTS,
  MAX_PRODUCTS_PER_ADD,
  MAX_RULE_SQFT,
  PAYMENT_TERMS,
  REPORTABLE_VISIT_SERVICES,
  type ReportableVisitService,
} from '@texasrenters/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InvoiceSettingsService } from './invoice-settings.service';

export class SaveInvoiceSettingsDto {
  @IsOptional() @IsString() @MaxLength(120) companyName!: string | null;
  @IsOptional() @IsString() @MaxLength(200) addressLine1!: string | null;
  @IsOptional() @IsString() @MaxLength(200) addressLine2!: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone!: string | null;
  @IsOptional() @IsString() @MaxLength(254) email!: string | null;
  @IsOptional() @IsString() @MaxLength(200) defaultSubject!: string | null;
  @IsOptional() @IsIn(PAYMENT_TERMS.map((option) => option.days)) defaultTermsDays!: number | null;
  @IsOptional() @IsString() @MaxLength(4000) defaultClientMessage!: string | null;
  @IsOptional() @IsString() @MaxLength(4000) defaultContractDisclaimer!: string | null;
  @IsOptional() @IsISO8601() expectedUpdatedAt!: string | null;
}

export class NewInvoiceProductDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsInt() @Min(0) @Max(MAX_PRODUCT_PRICE_CENTS) unitPriceCents!: number;
}

export class AddInvoiceProductsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PRODUCTS_PER_ADD)
  @ValidateNested({ each: true })
  @Type(() => NewInvoiceProductDto)
  products!: NewInvoiceProductDto[];
}

export class ChangeInvoiceProductDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_PRODUCT_PRICE_CENTS) unitPriceCents?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  /** The Xero organisation it goes to; null for none. */
  @IsOptional() @IsString() @MaxLength(64) xeroTenantId?: string | null;
  @IsISO8601() expectedUpdatedAt!: string;
}

/** A rule for what a finished visit bills (2026-11-12): every field of `NewBillingRule`. */
export class NewBillingRuleDto {
  /** The visit's type; null for any visit. */
  @IsOptional() @IsIn(Object.values(InspectionType)) inspectionType!: InspectionType | null;
  /** A service reported done; null for whatever was done. */
  @IsOptional() @IsIn([...REPORTABLE_VISIT_SERVICES]) service!: ReportableVisitService | null;
  @IsUUID() productId!: string;
  /** From this size of property on, in square feet, it bills `largeProductId` instead (2026-11-13). Both or neither. */
  @IsOptional() @IsInt() @Min(1) @Max(MAX_RULE_SQFT) largeFromSqFt?: number | null;
  @IsOptional() @IsUUID() largeProductId?: string | null;
}

export class AddBillingRulesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BILLING_RULES)
  @ValidateNested({ each: true })
  @Type(() => NewBillingRuleDto)
  rules!: NewBillingRuleDto[];
}

/**
 * Invoice settings (2026-11-06, phase 6): read by whoever reads invoices,
 * changed by whoever makes them -- `invoices:manage`, which an API key can
 * never hold. A route of its own, apart from `admin/invoices/:invoiceId`.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/invoice-settings')
export class InvoiceSettingsController {
  constructor(@Inject(InvoiceSettingsService) private readonly settings: InvoiceSettingsService) {}

  @Get()
  @RequirePermissions('invoices:read')
  read(@Req() request: AuthenticatedRequest) {
    return this.settings.read(request.user);
  }

  @Put()
  @RequirePermissions('invoices:read', 'invoices:manage')
  save(@Req() request: AuthenticatedRequest, @Body() body: SaveInvoiceSettingsDto) {
    return this.settings.save(request.user, body);
  }

  @Post('products')
  @RequirePermissions('invoices:read', 'invoices:manage')
  addProducts(@Req() request: AuthenticatedRequest, @Body() body: AddInvoiceProductsDto) {
    return this.settings.addProducts(request.user, body);
  }

  @Patch('products/:productId')
  @RequirePermissions('invoices:read', 'invoices:manage')
  changeProduct(
    @Req() request: AuthenticatedRequest,
    @Param('productId', new ParseUUIDPipe()) id: string,
    @Body() body: ChangeInvoiceProductDto,
  ) {
    return this.settings.changeProduct(request.user, id, body);
  }

  /** What a finished visit bills (2026-11-12): rules confirmed or written by the office. */
  @Post('billing-rules')
  @RequirePermissions('invoices:read', 'invoices:manage')
  addBillingRules(@Req() request: AuthenticatedRequest, @Body() body: AddBillingRulesDto) {
    return this.settings.addBillingRules(request.user, body);
  }

  @Delete('billing-rules/:ruleId')
  @RequirePermissions('invoices:read', 'invoices:manage')
  removeBillingRule(@Req() request: AuthenticatedRequest, @Param('ruleId', new ParseUUIDPipe()) id: string) {
    return this.settings.removeBillingRule(request.user, id);
  }
}
