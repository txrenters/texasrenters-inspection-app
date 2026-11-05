import { Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InvoiceFilesService } from './invoice-files.service';

/**
 * The files on Jobber's invoices (2026-11-06, phase 7): a short-lived link to
 * open one, for whoever reads invoices; and trying again the copies that
 * failed, for whoever makes them.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin')
export class InvoiceFilesController {
  constructor(@Inject(InvoiceFilesService) private readonly files: InvoiceFilesService) {}

  @Get('invoices/:invoiceId/files/:fileId/link')
  @RequirePermissions('invoices:read')
  link(
    @Req() request: AuthenticatedRequest,
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
  ) {
    return this.files.link(request.user, invoiceId, fileId);
  }

  @Post('invoice-settings/file-copies/retry')
  @RequirePermissions('invoices:read', 'invoices:manage')
  retry(@Req() request: AuthenticatedRequest) {
    return this.files.retryFailed(request.user);
  }
}
