import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { INVOICE_STATUS_ACTIONS, MAX_INVOICE_CENTS, MAX_INVOICE_LINES, type InvoiceStatusAction } from '@texasrenters/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InvoiceEditsService } from './invoice-edits.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class EditInvoiceLineDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }) @Min(0.01) @Max(10_000) quantity!: number;
  @IsInt() @Min(0) @Max(MAX_INVOICE_CENTS) unitPriceCents!: number;
  @IsOptional() @Matches(DAY) serviceOn?: string | null;
  @IsOptional() @IsBoolean() taxable?: boolean;
}

/** Either a percent or an amount; which one, and whether it fits the subtotal, is the shared rule's to say. */
export class InvoiceDiscountDto {
  @IsIn(['PERCENT', 'AMOUNT']) kind!: 'PERCENT' | 'AMOUNT';
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 3 }) @Min(0) @Max(100) percent?: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_INVOICE_CENTS) amountCents?: number;
}

export class InvoiceTaxDto {
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 3 }) @Min(0) @Max(100) percent!: number;
}

/** Jobber's "Client view" (2026-11-10). */
export class InvoiceClientViewDto {
  @IsBoolean() showQuantities!: boolean;
  @IsBoolean() showUnitPrices!: boolean;
  @IsBoolean() showLineTotals!: boolean;
  @IsBoolean() showAccountBalance!: boolean;
  @IsBoolean() showLateStamp!: boolean;
}

export class EditInvoiceDto {
  @IsString() @MinLength(1) @MaxLength(200) subject!: string;
  @IsOptional() @IsString() @MaxLength(30) number!: string | null;
  @Matches(DAY) issuedOn!: string;
  @Matches(DAY) dueOn!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INVOICE_LINES)
  @ValidateNested({ each: true })
  @Type(() => EditInvoiceLineDto)
  lineItems!: EditInvoiceLineDto[];
  @IsOptional() @ValidateNested() @Type(() => InvoiceDiscountDto) discount!: InvoiceDiscountDto | null;
  @IsOptional() @ValidateNested() @Type(() => InvoiceTaxDto) tax!: InvoiceTaxDto | null;
  @IsOptional() @IsString() @MaxLength(2000) clientMessage?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) contractDisclaimer?: string | null;
  @IsOptional() @ValidateNested() @Type(() => InvoiceClientViewDto) clientView?: InvoiceClientViewDto;
  @IsISO8601({ strict: true }) expectedUpdatedAt!: string;
}

export class InvoiceStatusChangeDto {
  @IsIn(INVOICE_STATUS_ACTIONS) action!: InvoiceStatusAction;
  @IsISO8601({ strict: true }) expectedUpdatedAt!: string;
}

export class RemoveInvoiceQueryDto {
  @IsISO8601({ strict: true }) expectedUpdatedAt!: string;
}

/**
 * Editing invoices (2026-11-06, phase 3): the same `admin/invoices` routes as
 * `InvoicesController`, kept apart so the writes read as one place. Each write
 * needs `invoices:manage`, which an API key can never hold, and reading, as it
 * answers with the invoice; the history needs reading alone.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/invoices')
export class InvoiceEditsController {
  constructor(@Inject(InvoiceEditsService) private readonly edits: InvoiceEditsService) {}

  @Get(':invoiceId/history')
  @RequirePermissions('invoices:read')
  history(@Req() request: AuthenticatedRequest, @Param('invoiceId', new ParseUUIDPipe()) id: string) {
    return this.edits.history(request.user, id);
  }

  @Patch(':invoiceId')
  @RequirePermissions('invoices:read', 'invoices:manage')
  edit(@Req() request: AuthenticatedRequest, @Param('invoiceId', new ParseUUIDPipe()) id: string, @Body() body: EditInvoiceDto) {
    return this.edits.edit(request.user, id, {
      ...body,
      discount: body.discount
        ? body.discount.kind === 'PERCENT'
          ? { kind: 'PERCENT', percent: body.discount.percent ?? 0 }
          : { kind: 'AMOUNT', amountCents: body.discount.amountCents ?? 0 }
        : null,
      tax: body.tax ?? null,
      number: body.number ?? null,
    });
  }

  @Post(':invoiceId/status')
  @RequirePermissions('invoices:read', 'invoices:manage')
  changeStatus(
    @Req() request: AuthenticatedRequest,
    @Param('invoiceId', new ParseUUIDPipe()) id: string,
    @Body() body: InvoiceStatusChangeDto,
  ) {
    return this.edits.changeStatus(request.user, id, body);
  }

  @Delete(':invoiceId')
  @RequirePermissions('invoices:read', 'invoices:manage')
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('invoiceId', new ParseUUIDPipe()) id: string,
    @Query() query: RemoveInvoiceQueryDto,
  ) {
    return this.edits.remove(request.user, id, query.expectedUpdatedAt);
  }
}
