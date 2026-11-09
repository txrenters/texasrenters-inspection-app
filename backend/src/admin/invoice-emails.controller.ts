import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MAX_BATCH_DELIVERY, MAX_FOLLOW_UP_DAY, MAX_FOLLOW_UP_STEPS, MAX_INVOICE_RECIPIENTS } from '@texasrenters/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
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
import { InvoiceDeliveryService } from './invoice-delivery.service';
import { InvoiceFollowUpsService } from './invoice-follow-ups.service';

/**
 * The emails Jobber sent on the office's behalf, and stops sending at Take
 * over (2026-11-09): follow-ups about unpaid invoices, receipts, and many
 * invoices at once. Each email is a billed call, so every route that sends
 * one needs a write grant an API key can never hold, and the console's daily
 * invoice email ceiling counts them all.
 */

export class SaveInvoiceEmailSettingsDto {
  @IsBoolean() followUpsEnabled!: boolean;
  @IsArray()
  @ArrayMaxSize(MAX_FOLLOW_UP_STEPS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(MAX_FOLLOW_UP_DAY, { each: true })
  followUpDays!: number[];
  @IsBoolean() receiptsAutomatic!: boolean;
  @IsOptional() @IsISO8601() expectedUpdatedAt!: string | null;
}

export class SendReceiptDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INVOICE_RECIPIENTS)
  @IsString({ each: true })
  @MaxLength(254, { each: true })
  to!: string[];
  @IsString() @MinLength(8) @MaxLength(120) clientRequestId!: string;
}

export class DeliverableQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) from!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) to!: string;
}

export class DeliverInvoiceDto {
  @IsUUID() invoiceId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INVOICE_RECIPIENTS)
  @IsString({ each: true })
  @MaxLength(254, { each: true })
  to!: string[];
}

export class DeliverInvoicesDto {
  @IsString() @MinLength(8) @MaxLength(80) batchKey!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BATCH_DELIVERY)
  @ValidateNested({ each: true })
  @Type(() => DeliverInvoiceDto)
  invoices!: DeliverInvoiceDto[];
  @IsOptional() @IsString() @MaxLength(2000) message?: string | null;
}

@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/invoice-settings')
export class InvoiceEmailSettingsController {
  constructor(@Inject(InvoiceFollowUpsService) private readonly followUps: InvoiceFollowUpsService) {}

  @Get('emails')
  @RequirePermissions('invoices:read')
  read(@Req() request: AuthenticatedRequest) {
    return this.followUps.settings(request.user);
  }

  @Put('emails')
  @RequirePermissions('invoices:read', 'invoices:manage')
  save(@Req() request: AuthenticatedRequest, @Body() body: SaveInvoiceEmailSettingsDto) {
    return this.followUps.saveSettings(request.user, { ...body, expectedUpdatedAt: body.expectedUpdatedAt ?? null });
  }
}

/** Kept off `admin/invoices`, where `:invoiceId` would take the word "deliverable" for an id. */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/invoice-delivery')
export class InvoiceBatchDeliveryController {
  constructor(@Inject(InvoiceDeliveryService) private readonly deliveries: InvoiceDeliveryService) {}

  @Get('deliverable')
  @RequirePermissions('invoices:read', 'invoices:manage')
  deliverable(@Req() request: AuthenticatedRequest, @Query() query: DeliverableQueryDto) {
    return this.deliveries.deliverable(request.user, query);
  }

  @Post('batch')
  @RequirePermissions('invoices:read', 'invoices:manage')
  deliver(@Req() request: AuthenticatedRequest, @Body() body: DeliverInvoicesDto) {
    return this.deliveries.deliverMany(request.user, body);
  }
}

@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/payments')
export class PaymentReceiptsController {
  constructor(@Inject(InvoiceDeliveryService) private readonly deliveries: InvoiceDeliveryService) {}

  @Post(':paymentId/receipt')
  @RequirePermissions('invoices:read', 'payments:record')
  sendReceipt(
    @Req() request: AuthenticatedRequest,
    @Param('paymentId', new ParseUUIDPipe()) id: string,
    @Body() body: SendReceiptDto,
  ) {
    return this.deliveries.sendReceipt(request.user, id, body);
  }
}
