import { Body, Controller, Get, Inject, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsOptional } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InvoiceAutoDraftsService } from './invoice-auto-drafts.service';

export class SaveInvoiceAutoDraftsDto {
  @IsBoolean() on!: boolean;
  /** The switch's `updatedAt` as it was read; null when it was never set. */
  @IsOptional() @IsISO8601() expectedUpdatedAt!: string | null;
}

/**
 * "Draft invoices automatically" (2026-11-13): read by whoever reads invoices,
 * turned on or off by whoever makes them.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/invoice-settings/auto-drafts')
export class InvoiceAutoDraftsController {
  constructor(@Inject(InvoiceAutoDraftsService) private readonly drafts: InvoiceAutoDraftsService) {}

  @Get()
  @RequirePermissions('invoices:read')
  read(@Req() request: AuthenticatedRequest) {
    return this.drafts.view(request.user);
  }

  @Put()
  @RequirePermissions('invoices:read', 'invoices:manage')
  save(@Req() request: AuthenticatedRequest, @Body() body: SaveInvoiceAutoDraftsDto) {
    return this.drafts.save(request.user, { on: body.on, expectedUpdatedAt: body.expectedUpdatedAt ?? null });
  }
}
