import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  INVOICE_FILTERS,
  InspectionType,
  MAX_BATCH_INVOICES,
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
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
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
import { InvoiceBatchService } from './invoice-batch.service';
import { InvoicesService } from './invoices.service';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class InvoiceListQueryDto {
  @IsOptional() @IsIn(INVOICE_FILTERS) filter?: InvoiceFilter;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(120) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @IsUUID() propertyId?: string;
  @IsOptional() @IsUUID() inspectionId?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) issuedFrom?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) issuedTo?: string;
}

/** A finished visit's draft, or a property's when no visit covers the work. One of the two. */
export class InvoiceDraftQueryDto {
  @IsOptional() @IsUUID() inspectionId?: string;
  @IsOptional() @IsUUID() propertyId?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class UninvoicedQueryDto {
  @Matches(DAY) from!: string;
  @Matches(DAY) to!: string;
  @IsOptional() @IsIn(Object.values(InspectionType)) inspectionType?: InspectionType;
}

export class BatchInvoiceDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BATCH_INVOICES)
  @IsUUID(undefined, { each: true })
  inspectionIds!: string[];
  @Matches(DAY) issuedOn!: string;
  @IsInt() @Min(0) @Max(365) paymentTermsDays!: number;
  @IsOptional() @IsBoolean() asDraft?: boolean;
  @IsString() @MinLength(8) @MaxLength(80) clientRequestId!: string;
}

export class PaymentListQueryDto {
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsIn(PAYMENT_METHODS) method?: PaymentMethod;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) paidFrom?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) paidTo?: string;
}

export class InvoiceLineDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }) @Min(0.01) @Max(10_000) quantity!: number;
  @IsInt() @Min(0) @Max(MAX_INVOICE_CENTS) unitPriceCents!: number;
}

export class CreateInvoiceDto {
  @IsOptional() @IsUUID() inspectionId?: string;
  @IsOptional() @IsUUID() propertyId?: string;
  @IsOptional() @IsBoolean() asDraft?: boolean;
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

/** A payment corrected. `expectedUpdatedAt` is the payment as it was read. */
export class ChangePaymentDto {
  @IsInt() @Min(1) @Max(MAX_INVOICE_CENTS) amountCents!: number;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) paidOn!: string;
  @IsIn(PAYMENT_METHODS) method!: PaymentMethod;
  @IsOptional() @IsString() @MaxLength(120) reference?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
  @IsISO8601({ strict: true }) expectedUpdatedAt!: string;
}

export class RemovePaymentQueryDto {
  @IsISO8601({ strict: true }) expectedUpdatedAt!: string;
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
  constructor(
    @Inject(InvoicesService) private readonly service: InvoicesService,
    @Inject(InvoiceBatchService) private readonly batches: InvoiceBatchService,
  ) {}

  @Get()
  @RequirePermissions('invoices:read')
  list(@Req() request: AuthenticatedRequest, @Query() query: InvoiceListQueryDto) {
    return this.service.list(request.user, query);
  }

  /** Declared before `:invoiceId`, which would otherwise take "draft" for an id. */
  @Get('draft')
  @RequirePermissions('invoices:read', 'invoices:manage')
  draft(@Req() request: AuthenticatedRequest, @Query() query: InvoiceDraftQueryDto) {
    return this.service.draft(request.user, query);
  }

  /** The finished visits with no invoice yet, for a batch (2026-11-06). Before `:invoiceId` too. */
  @Get('uninvoiced')
  @RequirePermissions('invoices:read', 'invoices:manage')
  uninvoiced(@Req() request: AuthenticatedRequest, @Query() query: UninvoicedQueryDto) {
    return this.batches.uninvoiced(request.user, query);
  }

  /** One invoice for each finished visit chosen, as Jobber's Batch Create (2026-11-06). */
  @Post('batch')
  @RequirePermissions('invoices:read', 'invoices:manage')
  batch(@Req() request: AuthenticatedRequest, @Body() body: BatchInvoiceDto) {
    return this.batches.batch(request.user, body);
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

  /** Correcting a payment is recording it again: the same grant, and reading to answer with it. */
  @Patch(':paymentId')
  @RequirePermissions('invoices:read', 'payments:record')
  change(
    @Req() request: AuthenticatedRequest,
    @Param('paymentId', new ParseUUIDPipe()) id: string,
    @Body() body: ChangePaymentDto,
  ) {
    return this.service.changePayment(request.user, id, body);
  }

  @Delete(':paymentId')
  @RequirePermissions('invoices:read', 'payments:record')
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('paymentId', new ParseUUIDPipe()) id: string,
    @Query() query: RemovePaymentQueryDto,
  ) {
    return this.service.removePayment(request.user, id, query.expectedUpdatedAt);
  }
}
