import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  INVOICE_FILTERS,
  InspectionType,
  MAX_BATCH_INVOICES,
  MAX_INVOICE_CENTS,
  MAX_INVOICE_LINES,
  MAX_INVOICES_PER_VISIT,
  MAX_LINE_TRACKING,
  PAYMENT_METHODS,
  XERO_TAX_MODES,
  type InvoiceFilter,
  type PaymentMethod,
  type XeroTaxMode,
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
import { InvoiceDeliveryService } from './invoice-delivery.service';
import { InvoicesService } from './invoices.service';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** A Xero organisation's tenant id: a GUID. */
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One company's invoices, or `none` for those of no company. */
const COMPANY = /^(none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export class InvoiceListQueryDto {
  @IsOptional() @IsIn(INVOICE_FILTERS) filter?: InvoiceFilter;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(120) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @IsUUID() propertyId?: string;
  @IsOptional() @IsUUID() inspectionId?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) issuedFrom?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) issuedTo?: string;
  @IsOptional() @Matches(COMPANY) company?: string;
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

/** A line's option in one of its company's tracking categories (2026-11-13). */
export class XeroLineTrackingDto {
  @IsString() @MinLength(1) @MaxLength(64) trackingCategoryId!: string;
  @IsString() @MinLength(1) @MaxLength(100) option!: string;
}

export class InvoiceLineDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }) @Min(0.01) @Max(10_000) quantity!: number;
  @IsInt() @Min(0) @Max(MAX_INVOICE_CENTS) unitPriceCents!: number;
  /** What the Xero-style form chose for the line (2026-11-13), each checked against its company's books as last read. */
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }) @Min(0) @Max(100) discountRate?: number | null;
  @IsOptional() @IsString() @MaxLength(64) xeroAccountId?: string | null;
  @IsOptional() @IsString() @MaxLength(64) xeroItemCode?: string | null;
  @IsOptional() @IsString() @MaxLength(64) xeroTaxType?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LINE_TRACKING)
  @ValidateNested({ each: true })
  @Type(() => XeroLineTrackingDto)
  xeroTracking?: XeroLineTrackingDto[] | null;
  @IsOptional() @IsUUID() xeroProjectId?: string | null;
}

export class CreateInvoiceDto {
  @IsOptional() @IsUUID() inspectionId?: string;
  @IsOptional() @IsUUID() propertyId?: string;
  @IsOptional() @IsBoolean() asDraft?: boolean;
  /** Another invoice for a visit invoiced already, on purpose (2026-11-13). */
  @IsOptional() @IsBoolean() additional?: boolean;
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
  /** The company's books it goes to; null for none, left out for its lines' company. */
  @IsOptional() @Matches(TENANT_ID) xeroTenantId?: string | null;
  /** The Xero-style form's due day, reference and tax (2026-11-13). */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueOn?: string;
  @IsOptional() @IsString() @MaxLength(255) reference?: string | null;
  @IsOptional() @IsIn(XERO_TAX_MODES) taxMode?: XeroTaxMode;
  @IsString() @MinLength(8) @MaxLength(120) clientRequestId!: string;
}

/** One company's invoice on a form that makes one per company (2026-11-10). */
export class InvoicePartDto {
  @IsOptional() @Matches(TENANT_ID) xeroTenantId?: string | null;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INVOICE_LINES)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lineItems!: InvoiceLineDto[];
  /** How its amounts carry tax in Xero, from the Xero-style form (2026-11-13). */
  @IsOptional() @IsIn(XERO_TAX_MODES) taxMode?: XeroTaxMode;
}

export class CreateInvoicesDto {
  @IsOptional() @IsUUID() inspectionId?: string;
  @IsOptional() @IsUUID() propertyId?: string;
  @IsOptional() @IsBoolean() asDraft?: boolean;
  /** Another invoice for a visit invoiced already, on purpose (2026-11-13). */
  @IsOptional() @IsBoolean() additional?: boolean;
  @IsString() @MinLength(1) @MaxLength(200) subject!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) issuedOn!: string;
  @IsInt() @Min(0) @Max(365) paymentTermsDays!: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INVOICES_PER_VISIT)
  @ValidateNested({ each: true })
  @Type(() => InvoicePartDto)
  invoices!: InvoicePartDto[];
  @IsOptional() @IsString() @MaxLength(2000) clientMessage?: string;
  /** The Xero-style form's due day and reference (2026-11-13), for every invoice it makes. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueOn?: string;
  @IsOptional() @IsString() @MaxLength(255) reference?: string | null;
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
    @Inject(InvoiceDeliveryService) private readonly deliveries: InvoiceDeliveryService,
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

  /** One invoice per company from one form (2026-11-10): each with its own lines, made together or not at all. */
  @Post('per-company')
  @RequirePermissions('invoices:read', 'invoices:manage')
  createPerCompany(@Req() request: AuthenticatedRequest, @Body() body: CreateInvoicesDto) {
    return this.service.createPerCompany(request.user, body);
  }

  @Post(':invoiceId/payments')
  @RequirePermissions('invoices:read', 'payments:record')
  async recordPayment(
    @Req() request: AuthenticatedRequest,
    @Param('invoiceId', new ParseUUIDPipe()) id: string,
    @Body() body: RecordPaymentDto,
  ) {
    const invoice = await this.service.recordPayment(request.user, id, body);
    // Its receipt, when the office sends them by themselves. Not awaited: the
    // payment is recorded whatever the mail provider does, and never waits on it.
    void this.deliveries.receiptAfterPayment(request.user, id, body.clientRequestId);
    return invoice;
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
