import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  MOST_STOCK_QUANTITY,
  MOST_UNIT_COST_CENTS,
  STOCK_PLACE_KINDS,
  type OpeningBalanceInput,
  type ReverseMovementInput,
  type SaveStockCategoryInput,
  type SaveStockItemInput,
  type SaveStockPlaceInput,
  type SaveVendorInput,
  type StockPlaceKind,
} from '@texasrenters/shared';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InventoryService } from './inventory.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Present and null clears the field; left out leaves it alone. */
const SET = (_: object, value: unknown) => value !== null && value !== undefined;

/**
 * Every field of each contract input is named in its DTO: the validation pipe
 * refuses any field it does not know (inventory.spec.ts runs the pipe).
 */
export class SaveStockItemDto implements Required<SaveStockItemInput> {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) unit!: string;
  @IsOptional() @IsUUID() categoryId!: string;
  @ValidateIf(SET) @IsString() @MaxLength(80) xeroTenantId!: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(MOST_STOCK_QUANTITY) reorderLevel!: number;
  @IsOptional() @IsInt() @Min(0) @Max(MOST_STOCK_QUANTITY) reorderQuantity!: number;
  @ValidateIf(SET) @IsUUID() usualVendorId!: string | null;
  @IsOptional() @IsBoolean() active!: boolean;
}

/** The prefix in either case; the service stores it upper case and the database checks its shape. */
export class SaveStockCategoryDto implements Required<SaveStockCategoryInput> {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsOptional() @Matches(/^[A-Za-z][A-Za-z0-9]{1,5}$/) prefix!: string;
  @IsOptional() @IsBoolean() active!: boolean;
}

export class OpeningBalanceDto implements Required<OpeningBalanceInput> {
  @IsUUID() placeId!: string;
  @IsInt() @Min(1) @Max(MOST_STOCK_QUANTITY) quantity!: number;
  @IsInt() @Min(0) @Max(MOST_UNIT_COST_CENTS) unitCostCents!: number;
  @IsOptional() @Matches(DAY) day!: string;
  @ValidateIf(SET) @IsString() @MaxLength(500) note!: string | null;
  @IsUUID() requestKey!: string;
}

export class ReverseMovementDto implements Required<ReverseMovementInput> {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class SaveStockPlaceDto implements Required<SaveStockPlaceInput> {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsIn(STOCK_PLACE_KINDS) kind!: StockPlaceKind;
  @ValidateIf(SET) @IsUUID() technicianId!: string | null;
  @IsOptional() @IsBoolean() active!: boolean;
}

export class SaveVendorDto implements Required<SaveVendorInput> {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @ValidateIf(SET) @IsString() @MaxLength(120) contactName!: string | null;
  @ValidateIf(SET) @IsEmail() @MaxLength(320) email!: string | null;
  @ValidateIf(SET) @IsString() @MaxLength(40) phone!: string | null;
  @ValidateIf(SET) @IsString() @MaxLength(60) terms!: string | null;
  @ValidateIf(SET) @IsString() @MaxLength(2000) notes!: string | null;
  @IsOptional() @IsBoolean() active!: boolean;
}

/**
 * Inventory (2026-11-19, phase 1): read with `inventory:read`, changed with
 * `inventory:manage`, which no API key may hold. Every change is audited, and
 * a stock movement is only ever added.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/inventory')
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly inventory: InventoryService) {}

  @Get('items')
  @RequirePermissions('inventory:read')
  stock(@Req() request: AuthenticatedRequest) {
    return this.inventory.stock(request.user);
  }

  @Post('items')
  @RequirePermissions('inventory:manage')
  createItem(@Req() request: AuthenticatedRequest, @Body() body: SaveStockItemDto) {
    return this.inventory.createItem(request.user, body);
  }

  @Get('items/:itemId')
  @RequirePermissions('inventory:read')
  item(@Req() request: AuthenticatedRequest, @Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.inventory.item(request.user, itemId);
  }

  @Patch('items/:itemId')
  @RequirePermissions('inventory:manage')
  updateItem(@Req() request: AuthenticatedRequest, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() body: SaveStockItemDto) {
    return this.inventory.updateItem(request.user, itemId, body);
  }

  @Post('items/:itemId/opening-balance')
  @RequirePermissions('inventory:manage')
  enterOpeningBalance(@Req() request: AuthenticatedRequest, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() body: OpeningBalanceDto) {
    return this.inventory.enterOpeningBalance(request.user, itemId, body);
  }

  @Post('movements/:movementId/reverse')
  @RequirePermissions('inventory:manage')
  reverseMovement(@Req() request: AuthenticatedRequest, @Param('movementId', ParseUUIDPipe) movementId: string, @Body() body: ReverseMovementDto) {
    return this.inventory.reverseMovement(request.user, movementId, body);
  }

  @Post('categories')
  @RequirePermissions('inventory:manage')
  createCategory(@Req() request: AuthenticatedRequest, @Body() body: SaveStockCategoryDto) {
    return this.inventory.createCategory(request.user, body);
  }

  @Patch('categories/:categoryId')
  @RequirePermissions('inventory:manage')
  updateCategory(@Req() request: AuthenticatedRequest, @Param('categoryId', ParseUUIDPipe) categoryId: string, @Body() body: SaveStockCategoryDto) {
    return this.inventory.updateCategory(request.user, categoryId, body);
  }

  @Get('places')
  @RequirePermissions('inventory:read')
  places(@Req() request: AuthenticatedRequest) {
    return this.inventory.places(request.user);
  }

  @Post('places')
  @RequirePermissions('inventory:manage')
  createPlace(@Req() request: AuthenticatedRequest, @Body() body: SaveStockPlaceDto) {
    return this.inventory.createPlace(request.user, body);
  }

  @Patch('places/:placeId')
  @RequirePermissions('inventory:manage')
  updatePlace(@Req() request: AuthenticatedRequest, @Param('placeId', ParseUUIDPipe) placeId: string, @Body() body: SaveStockPlaceDto) {
    return this.inventory.updatePlace(request.user, placeId, body);
  }

  @Get('vendors')
  @RequirePermissions('inventory:read')
  vendors(@Req() request: AuthenticatedRequest) {
    return this.inventory.vendors(request.user);
  }

  @Post('vendors')
  @RequirePermissions('inventory:manage')
  createVendor(@Req() request: AuthenticatedRequest, @Body() body: SaveVendorDto) {
    return this.inventory.createVendor(request.user, body);
  }

  @Patch('vendors/:vendorId')
  @RequirePermissions('inventory:manage')
  updateVendor(@Req() request: AuthenticatedRequest, @Param('vendorId', ParseUUIDPipe) vendorId: string, @Body() body: SaveVendorDto) {
    return this.inventory.updateVendor(request.user, vendorId, body);
  }
}
