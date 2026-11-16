import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CLOCK_TIME, REVENUE_COLUMNS, type RevenueColumn, type SaveRevenueLogEntryInput } from '@texasrenters/shared';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { ActualVsBudgetService } from './actual-vs-budget.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A visit's money is never near this; it stops a typo of extra zeros. */
const MOST_CENTS = 10_000_000;
/** Present and null clears the office's cell; left out leaves it alone. */
const SET = (_: object, value: unknown) => value !== null && value !== undefined;

export class RevenueLogQueryDto {
  @IsUUID() technicianId!: string;
  @Matches(DAY) from!: string;
  @Matches(DAY) to!: string;
}

/**
 * The office's cells for a row. Every field of `SaveRevenueLogEntryInput`
 * is named here: the validation pipe refuses any field it does not know.
 */
export class SaveRevenueLogEntryDto implements Required<Omit<SaveRevenueLogEntryInput, 'inspectionId'>> {
  @IsOptional() @IsUUID() technicianId!: string;
  @IsOptional() @Matches(DAY) date!: string;
  @ValidateIf(SET) @IsString() @MaxLength(300) address!: string | null;
  @ValidateIf(SET) @IsString() @MaxLength(60) workOrder!: string | null;
  @ValidateIf(SET) @IsString() @MaxLength(60) jobNumber!: string | null;
  @ValidateIf(SET) @IsString() @MaxLength(60) driveTime!: string | null;
  @ValidateIf(SET) @IsString() @MaxLength(60) timeBudgeted!: string | null;
  @ValidateIf(SET) @IsInt() @Min(0) @Max(MOST_CENTS) estimatedBudgetCents!: number | null;
  @ValidateIf(SET) @Matches(CLOCK_TIME) arrival!: string | null;
  @ValidateIf(SET) @Matches(CLOCK_TIME) leaving!: string | null;
  @ValidateIf(SET) @IsBoolean() workComplete!: boolean | null;
  @ValidateIf(SET) @IsBoolean() rescheduleRequired!: boolean | null;
  @ValidateIf(SET) @Matches(DAY) rescheduleOn!: string | null;
  @ValidateIf(SET) @IsInt() @Min(0) @Max(MOST_CENTS) laborCents!: number | null;
  @ValidateIf(SET) @IsInt() @Min(0) @Max(MOST_CENTS) serviceCallFeeCents!: number | null;
  @ValidateIf(SET) @IsInt() @Min(0) @Max(MOST_CENTS) materialsCents!: number | null;
  @ValidateIf(SET) @IsString() @MaxLength(120) invoiceNumber!: string | null;
  @ValidateIf(SET) @IsString() @MaxLength(60) postedInPw!: string | null;
  @ValidateIf(SET) @IsString() @MaxLength(2000) notes!: string | null;
}

export class SaveRevenueProductColumnDto {
  @IsIn(REVENUE_COLUMNS) column!: RevenueColumn;
}

/**
 * Actual vs Budget (2026-11-17): the office's revenue monitoring. Money, so it
 * is read with `invoices:read` and typed into with `invoices:manage`, as the
 * invoices are; a technician sees none of it. Every save is audited.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/actual-vs-budget')
export class ActualVsBudgetController {
  constructor(@Inject(ActualVsBudgetService) private readonly revenue: ActualVsBudgetService) {}

  @Get('technicians')
  @RequirePermissions('invoices:read')
  technicians(@Req() request: AuthenticatedRequest) {
    return this.revenue.technicians(request.user);
  }

  @Get('log')
  @RequirePermissions('invoices:read')
  log(@Req() request: AuthenticatedRequest, @Query() query: RevenueLogQueryDto) {
    return this.revenue.log(request.user, query);
  }

  @Put('log/visits/:inspectionId')
  @RequirePermissions('invoices:manage')
  saveVisit(@Req() request: AuthenticatedRequest, @Param('inspectionId', ParseUUIDPipe) inspectionId: string, @Body() body: SaveRevenueLogEntryDto) {
    return this.revenue.saveVisit(request.user, inspectionId, body);
  }

  @Post('log/entries')
  @RequirePermissions('invoices:manage')
  addRow(@Req() request: AuthenticatedRequest, @Body() body: SaveRevenueLogEntryDto) {
    return this.revenue.addRow(request.user, body);
  }

  @Patch('log/entries/:entryId')
  @RequirePermissions('invoices:manage')
  saveEntry(@Req() request: AuthenticatedRequest, @Param('entryId', ParseUUIDPipe) entryId: string, @Body() body: SaveRevenueLogEntryDto) {
    return this.revenue.saveEntry(request.user, entryId, body);
  }

  @Delete('log/entries/:entryId')
  @RequirePermissions('invoices:manage')
  @HttpCode(200)
  removeRow(@Req() request: AuthenticatedRequest, @Param('entryId', ParseUUIDPipe) entryId: string) {
    return this.revenue.removeRow(request.user, entryId);
  }

  @Get('products')
  @RequirePermissions('invoices:read')
  productColumns(@Req() request: AuthenticatedRequest) {
    return this.revenue.productColumns(request.user);
  }

  @Put('products/:productId')
  @RequirePermissions('invoices:manage')
  saveProductColumn(@Req() request: AuthenticatedRequest, @Param('productId', ParseUUIDPipe) productId: string, @Body() body: SaveRevenueProductColumnDto) {
    return this.revenue.saveProductColumn(request.user, productId, body.column);
  }
}
