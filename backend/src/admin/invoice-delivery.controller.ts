import { Body, Controller, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MAX_INVOICE_RECIPIENTS } from '@texasrenters/shared';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InvoiceDeliveryService } from './invoice-delivery.service';

export class SendInvoiceDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INVOICE_RECIPIENTS)
  @IsString({ each: true })
  @MaxLength(254, { each: true })
  to!: string[];
  @IsOptional() @IsString() @MaxLength(2000) message?: string | null;
  @IsString() @MinLength(8) @MaxLength(120) clientRequestId!: string;
}

/**
 * Sending an invoice (2026-11-06, phase 5): the same `admin/invoices` routes,
 * kept apart because this is the one that calls a billed provider. It needs
 * `invoices:manage`, which an API key can never hold, and reading, as it
 * answers with the invoice.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/invoices')
export class InvoiceDeliveryController {
  constructor(@Inject(InvoiceDeliveryService) private readonly deliveries: InvoiceDeliveryService) {}

  @Post(':invoiceId/send')
  @RequirePermissions('invoices:read', 'invoices:manage')
  send(@Req() request: AuthenticatedRequest, @Param('invoiceId', new ParseUUIDPipe()) id: string, @Body() body: SendInvoiceDto) {
    return this.deliveries.send(request.user, id, body);
  }
}
