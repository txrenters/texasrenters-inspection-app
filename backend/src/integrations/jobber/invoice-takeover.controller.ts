import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../../common/auth';
import { InvoiceTakeoverService } from './invoice-takeover.service';

export class TakeOverInvoicingDto {
  @IsOptional() @IsBoolean() acceptFailedFiles?: boolean;
}

/**
 * Taking invoicing over from Jobber (2026-11-06, phase 8): what it waits on,
 * for whoever reads invoices; taking it over, or undoing that while nothing
 * has changed since, for whoever both makes invoices and runs the
 * integrations -- in production, the system administrator.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/invoice-takeover')
export class InvoiceTakeoverController {
  constructor(@Inject(InvoiceTakeoverService) private readonly takeover: InvoiceTakeoverService) {}

  @Get()
  @RequirePermissions('invoices:read')
  view(@Req() request: AuthenticatedRequest) {
    return this.takeover.view(request.user);
  }

  @Post()
  @HttpCode(200)
  @RequirePermissions('invoices:read', 'invoices:manage', 'integrations:manage')
  takeOver(@Req() request: AuthenticatedRequest, @Body() body: TakeOverInvoicingDto) {
    return this.takeover.takeOver(request.user, body);
  }

  @Post('undo')
  @HttpCode(200)
  @RequirePermissions('invoices:read', 'invoices:manage', 'integrations:manage')
  undo(@Req() request: AuthenticatedRequest) {
    return this.takeover.undo(request.user);
  }
}
