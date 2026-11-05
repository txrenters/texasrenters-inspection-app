import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MAX_PRODUCT_PRICE_CENTS, MAX_PRODUCTS_PER_ADD, PAYMENT_TERMS } from '@texasrenters/shared';
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
  @IsISO8601() expectedUpdatedAt!: string;
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
}
