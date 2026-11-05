import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  INVOICE_FILTERS,
  MAX_INVOICE_CENTS,
  MAX_INVOICE_LINES,
  PAYMENT_METHODS,
  type InvoiceFilter,
  type PaymentMethod,
} from '@texasrenters/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InvoicesService } from './invoices.service';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class InvoiceListQueryDto {
  @IsOptional() @IsIn(INVOICE_FILTERS) filter?: InvoiceFilter;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(120) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @IsUUID() propertyId?: string;
  @IsOptional() @IsUUID() inspectionId?: string;
}

export class InvoiceDraftQueryDto {
  @IsUUID() inspectionId!: string;
}

export class PaymentListQueryDto {
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsIn(PAYMENT_METHODS) method?: PaymentMethod;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class InvoiceLineDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }) @Min(0.01) @Max(10_000) quantity!: number;
  @IsInt() @Min(0) @Max(MAX_INVOICE_CENTS) unitPriceCents!: number;
}

export class CreateInvoiceDto {
  @IsUUID() inspectionId!: string;
  @IsString() @MinLength(1) @MaxLength(200) subject!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) issuedOn!: string;
  @IsInt() @Min(0) @Max(365) paymentTermsDays!: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INVOICE_LINES)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lineItems!: InvoiceLineDto[];
  @IsOptional() @IsString() @MaxLength(2000) clientMessage?: string;
  @IsString() @MinLength(8) @MaxLength(120) clientRequestId!: string;
}

export class RecordPaymentDto {
  @IsInt() @Min(1) @Max(MAX_INVOICE_CENTS) amountCents!: number;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) paidOn!: string;
  @IsIn(PAYMENT_METHODS) method!: PaymentMethod;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsString() @MinLength(8) @MaxLength(120) clientRequestId!: string;
}

/**
 * The console's invoices (2026-11-05): read with `invoices:read`, made with
 * `invoices:manage`, paid with `payments:record`. The guard requires every
 * permission it is given, so each write also asks for reading -- it answers
 * with the invoice.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/invoices')
export class InvoicesController {
  constructor(@Inject(InvoicesService) private readonly service: InvoicesService) {}

  @Get()
  @RequirePermissions('invoices:read')
  list(@Req() request: AuthenticatedRequest, @Query() query: InvoiceListQueryDto) {
    return this.service.list(request.user, query);
  }

  /** Declared before `:invoiceId`, which would otherwise take "draft" for an id. */
  @Get('draft')
  @RequirePermissions('invoices:read', 'invoices:manage')
  draft(@Req() request: AuthenticatedRequest, @Query() query: InvoiceDraftQueryDto) {
    return this.service.draft(request.user, query.inspectionId);
  }

  @Get(':invoiceId')
  @RequirePermissions('invoices:read')
  one(@Req() request: AuthenticatedRequest, @Param('invoiceId', new ParseUUIDPipe()) id: string) {
    return this.service.one(request.user, id);
  }

  @Post()
  @RequirePermissions('invoices:read', 'invoices:manage')
  create(@Req() request: AuthenticatedRequest, @Body() body: CreateInvoiceDto) {
    return this.service.create(request.user, body);
  }

  @Post(':invoiceId/payments')
  @RequirePermissions('invoices:read', 'payments:record')
  recordPayment(
    @Req() request: AuthenticatedRequest,
    @Param('invoiceId', new ParseUUIDPipe()) id: string,
    @Body() body: RecordPaymentDto,
  ) {
    return this.service.recordPayment(request.user, id, body);
  }
}

@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/payments')
export class PaymentsController {
  constructor(@Inject(InvoicesService) private readonly service: InvoicesService) {}

  @Get()
  @RequirePermissions('invoices:read')
  list(@Req() request: AuthenticatedRequest, @Query() query: PaymentListQueryDto) {
    return this.service.payments(request.user, query);
  }

  @Get(':paymentId')
  @RequirePermissions('invoices:read')
  one(@Req() request: AuthenticatedRequest, @Param('paymentId', new ParseUUIDPipe()) id: string) {
    return this.service.onePayment(request.user, id);
  }
}
