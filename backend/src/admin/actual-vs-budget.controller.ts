import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CLOCK_TIME,
  REVENUE_COLUMNS,
  type RevenueColumn,
  type SaveRevenueBudgetsInput,
  type SaveRevenueDayInput,
  type SaveRevenueMonthInput,
  type SaveRevenueWeekInput,
  type SaveRevenueLogEntryInput,
} from '@texasrenters/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { ActualVsBudgetService, MAX_WORKBOOK_BYTES, type UploadedWorkbook } from './actual-vs-budget.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A visit's money is never near this; it stops a typo of extra zeros. */
const MOST_CENTS = 10_000_000;
/** Present and null clears the office's cell; left out leaves it alone. */
const SET = (_: object, value: unknown) => value !== null && value !== undefined;
/** A day in the path, refused unless it is one. */
const dayParam = (value: string) => {
  if (!DAY.test(value)) throw new ApplicationError(422, 'BAD_DATES', 'Give the day as YYYY-MM-DD.');
  return value;
};

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

export class RevenueDayQueryDto {
  @Matches(DAY) date!: string;
}

/** What the office types for a technician's day. Every field of `SaveRevenueDayInput` is named here. */
export class SaveRevenueDayDto implements Required<SaveRevenueDayInput> {
  @ValidateIf(SET) @IsInt() @Min(0) @Max(MOST_CENTS) budgetCents!: number | null;
  @ValidateIf(SET) @IsInt() @Min(0) @Max(86_400) workSeconds!: number | null;
  @ValidateIf(SET) @IsString() @MaxLength(2000) projectionRemarks!: string | null;
  @ValidateIf(SET) @IsString() @MaxLength(2000) dailyRemarks!: string | null;
  @ValidateIf(SET) @IsString() @MaxLength(2000) trackerRemarks!: string | null;
}

export class RevenueBudgetRowDto {
  @IsUUID() technicianId!: string;
  @ValidateIf(SET) @IsInt() @Min(0) @Max(MOST_CENTS) dailyBudgetCents!: number | null;
  @ValidateIf(SET) @IsInt() @Min(0) @Max(MOST_CENTS) otRateCents!: number | null;
}

/** Each technician's budget and overtime rate, and the payroll periods. Every field of the contract is named. */
export class SaveRevenueBudgetsDto implements Required<SaveRevenueBudgetsInput> {
  @IsOptional() @Matches(DAY) payrollPeriodStart!: string;
  @IsOptional() @IsInt() @Min(1) @Max(31) payrollPeriodDays!: number;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => RevenueBudgetRowDto) technicians!: RevenueBudgetRowDto[];
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export class RevenueMonthQueryDto {
  @Matches(MONTH) month!: string;
}

/** What the office types for a technician's week. Every field of `SaveRevenueWeekInput` is named here. */
export class SaveRevenueWeekDto implements Required<SaveRevenueWeekInput> {
  @ValidateIf(SET) @IsInt() @Min(0) @Max(MOST_CENTS) targetCents!: number | null;
  @ValidateIf(SET) @IsInt() @Min(0) @Max(MOST_CENTS) actualCents!: number | null;
  @ValidateIf(SET) @IsString() @MaxLength(2000) remarks!: string | null;
}

/** What the office types for a technician's month. Every field of `SaveRevenueMonthInput` is named here. */
export class SaveRevenueMonthDto implements Required<SaveRevenueMonthInput> {
  @ValidateIf(SET) @IsString() @MaxLength(2000) remarks!: string | null;
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

  @Get('day')
  @RequirePermissions('invoices:read')
  day(@Req() request: AuthenticatedRequest, @Query() query: RevenueDayQueryDto) {
    return this.revenue.day(request.user, query.date);
  }

  @Put('day/:technicianId/:date')
  @RequirePermissions('invoices:manage')
  saveDay(
    @Req() request: AuthenticatedRequest,
    @Param('technicianId', ParseUUIDPipe) technicianId: string,
    @Param() params: { date: string },
    @Body() body: SaveRevenueDayDto,
  ) {
    return this.revenue.saveDay(request.user, technicianId, dayParam(params.date), body);
  }

  @Get('month')
  @RequirePermissions('invoices:read')
  month(@Req() request: AuthenticatedRequest, @Query() query: RevenueMonthQueryDto) {
    return this.revenue.month(request.user, query.month);
  }

  @Put('week/:technicianId/:weekStart')
  @RequirePermissions('invoices:manage')
  saveWeek(
    @Req() request: AuthenticatedRequest,
    @Param('technicianId', ParseUUIDPipe) technicianId: string,
    @Param() params: { weekStart: string },
    @Body() body: SaveRevenueWeekDto,
  ) {
    return this.revenue.saveWeek(request.user, technicianId, dayParam(params.weekStart), body);
  }

  @Put('month/:technicianId/:month')
  @RequirePermissions('invoices:manage')
  saveMonth(
    @Req() request: AuthenticatedRequest,
    @Param('technicianId', ParseUUIDPipe) technicianId: string,
    @Param() params: { month: string },
    @Body() body: SaveRevenueMonthDto,
  ) {
    return this.revenue.saveMonth(request.user, technicianId, params.month, body);
  }

  /** Import the past technicians' logs from the office's workbook: its hidden technician tabs. */
  @Post('history')
  @RequirePermissions('invoices:manage')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_WORKBOOK_BYTES, files: 1 } }))
  importHistory(@Req() request: AuthenticatedRequest, @UploadedFile() file?: UploadedWorkbook) {
    return this.revenue.importHistory(request.user, file);
  }

  @Get('history')
  @RequirePermissions('invoices:read')
  historyList(@Req() request: AuthenticatedRequest) {
    return this.revenue.historyList(request.user);
  }

  @Get('history/:id')
  @RequirePermissions('invoices:read')
  historySheet(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.revenue.historySheet(request.user, id);
  }

  @Get('budgets')
  @RequirePermissions('invoices:read')
  budgets(@Req() request: AuthenticatedRequest) {
    return this.revenue.budgets(request.user);
  }

  @Put('budgets')
  @RequirePermissions('invoices:manage')
  saveBudgets(@Req() request: AuthenticatedRequest, @Body() body: SaveRevenueBudgetsDto) {
    return this.revenue.saveBudgets(request.user, body);
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
