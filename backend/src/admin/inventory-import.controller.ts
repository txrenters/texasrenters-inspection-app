import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MOST_IMPORT_ROWS, type StockImportInput, type StockImportRow } from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InventoryImportService } from './inventory-import.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const GIVEN = (_: object, value: unknown) => value !== undefined && value !== null;
/** A cell of the sheet, as text. */
const CELL = 200;

/** One row of the stock import, every column named, each cell as text (2026-11-23). */
export class StockImportRowDto implements Required<StockImportRow> {
  @IsInt() @Min(1) line!: number;
  @IsString() @MaxLength(CELL) code!: string;
  @IsString() @MaxLength(CELL) description!: string;
  @IsString() @MaxLength(CELL) category!: string;
  @IsString() @MaxLength(CELL) unit!: string;
  @IsString() @MaxLength(CELL) company!: string;
  @IsString() @MaxLength(CELL) place!: string;
  @IsString() @MaxLength(CELL) quantity!: string;
  @IsString() @MaxLength(CELL) unitCost!: string;
  @IsString() @MaxLength(CELL) price!: string;
  @IsString() @MaxLength(CELL) reorderLevel!: string;
  @IsString() @MaxLength(CELL) reorderQuantity!: string;
  @IsString() @MaxLength(CELL) vendor!: string;
}

export class StockImportDto implements Required<StockImportInput> {
  // One more than the most, so the service says "split it in two" rather than the pipe refusing it bare.
  @IsArray() @ArrayMaxSize(MOST_IMPORT_ROWS + 1) @ValidateNested({ each: true }) @Type(() => StockImportRowDto) rows!: StockImportRowDto[];
  @IsOptional() @Matches(DAY) day!: string;
  @ValidateIf(GIVEN) @IsString() @MaxLength(200) fileName!: string | null;
  @IsOptional() @IsUUID() requestKey!: string;
}

/**
 * Importing the office's stock from a spreadsheet: check the file, then
 * import it. Opening balances need "Manage inventory", as by hand; a new code
 * needs whoever keeps the item codes, which the service checks.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/inventory/import')
export class InventoryImportController {
  constructor(@Inject(InventoryImportService) private readonly imports: InventoryImportService) {}

  @Post('check')
  @HttpCode(200)
  @RequirePermissions('inventory:read', 'inventory:manage')
  check(@Req() request: AuthenticatedRequest, @Body() body: StockImportDto) {
    return this.imports.check(request.user, body);
  }

  @Post()
  @RequirePermissions('inventory:read', 'inventory:manage')
  import(@Req() request: AuthenticatedRequest, @Body() body: StockImportDto) {
    return this.imports.import(request.user, body);
  }
}
