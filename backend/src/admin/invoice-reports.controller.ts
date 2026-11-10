import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { InvoiceReportDate, InvoiceStatus, TaxBasis } from '@texasrenters/shared';
import { IsIn, IsOptional, Matches } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InvoiceReportsService } from './invoice-reports.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The statuses an invoice is stored with; past due is worked out, never stored. */
const STORED_STATUSES = ['DRAFT', 'AWAITING_PAYMENT', 'PAID', 'BAD_DEBT', 'VOIDED'] as const;

/** One company's invoices (2026-11-10): an organisation's tenant id, or `none` for those of no company. */
const COMPANY = /^(none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export class ReportCompanyDto {
  @IsOptional() @Matches(COMPANY) company?: string;
}

export class ReportRangeDto extends ReportCompanyDto {
  @Matches(DAY) from!: string;
  @Matches(DAY) to!: string;
}

export class InvoicesReportDto extends ReportRangeDto {
  @IsIn(['created', 'issued']) dateField!: InvoiceReportDate;
  @IsOptional() @IsIn(STORED_STATUSES) status?: InvoiceStatus;
}

export class TaxReportDto extends ReportRangeDto {
  @IsIn(['ACCRUAL', 'CASH']) basis!: TaxBasis;
}

/**
 * Jobber's financial reports, read from the console's own copy (2026-11-09,
 * phase 2 of the invoice gap review). Read with `invoices:read`, as the
 * invoices themselves are; nothing here writes or calls anything billed.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@RequirePermissions('invoices:read')
@Controller('admin/invoice-reports')
export class InvoiceReportsController {
  constructor(@Inject(InvoiceReportsService) private readonly reports: InvoiceReportsService) {}

  @Get('projected-income')
  projectedIncome(@Req() request: AuthenticatedRequest, @Query() query: ReportCompanyDto) {
    return this.reports.projectedIncome(request.user, query.company);
  }

  @Get('aged-receivables')
  agedReceivables(@Req() request: AuthenticatedRequest, @Query() query: ReportCompanyDto) {
    return this.reports.agedReceivables(request.user, query.company);
  }

  @Get('transactions')
  transactions(@Req() request: AuthenticatedRequest, @Query() query: ReportRangeDto) {
    return this.reports.transactions(request.user, { from: query.from, to: query.to }, query.company);
  }

  @Get('invoices')
  invoices(@Req() request: AuthenticatedRequest, @Query() query: InvoicesReportDto) {
    return this.reports.invoices(request.user, query, query.company);
  }

  @Get('taxes')
  taxes(@Req() request: AuthenticatedRequest, @Query() query: TaxReportDto) {
    return this.reports.taxes(request.user, query, query.company);
  }

  @Get('client-balances')
  clientBalances(@Req() request: AuthenticatedRequest, @Query() query: ReportCompanyDto) {
    return this.reports.clientBalances(request.user, query.company);
  }

  @Get('payment-insights')
  paymentInsights(@Req() request: AuthenticatedRequest) {
    return this.reports.paymentInsights(request.user);
  }
}
