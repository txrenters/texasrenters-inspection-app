import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  MOST_ITEM_PRICE_CENTS,
  MOST_STOCK_QUANTITY,
  MOST_UNIT_COST_CENTS,
  STOCK_ITEM_DELETE_REASONS,
  STOCK_PLACE_KINDS,
  STOCK_REMOVAL_REASONS,
  type DeleteStockItemInput,
  type OpeningBalanceInput,
  type RemoveStockInput,
  type ReverseMovementInput,
  type StockItemDeleteReason,
  type StockRemovalReason,
  type SaveStockCategoryInput,
  type SaveStockItemInput,
  type SaveStockPlaceInput,
  type SaveVendorInput,
  type StockPlaceKind,
  KEEPER_PERMISSIONS,
  type PermissionKey,
} from '@texasrenters/shared';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequireAnyPermission, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InventoryService } from './inventory.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Present and null clears the field; left out leaves it alone. */
const SET = (_: object, value: unknown) => value !== null && value !== undefined;

/**
 * Every field of each contract input is named in its DTO: the validation pipe
 * refuses any field it does not know (inventory.spec.ts runs the pipe).
 */
export class SaveStockItemDto implements Required<SaveStockItemInput> {
  /** In either case; the service keeps it in capitals and says what shape it must be. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) code!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) unit!: string;
  @IsOptional() @IsUUID() categoryId!: string;
  @ValidateIf(SET) @IsString() @MaxLength(80) xeroTenantId!: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(MOST_STOCK_QUANTITY) reorderLevel!: number;
  @IsOptional() @IsInt() @Min(0) @Max(MOST_STOCK_QUANTITY) reorderQuantity!: number;
  @ValidateIf(SET) @IsUUID() usualVendorId!: string | null;
  @ValidateIf(SET) @IsInt() @Min(0) @Max(MOST_ITEM_PRICE_CENTS) priceCents!: number | null;
  @IsOptional() @IsBoolean() active!: boolean;
  @IsOptional() @IsUUID() lineTypeId!: string;
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

/** Stock taken off the books with a reason (2026-11-24). No place: every place, all of it. */
export class RemoveStockDto implements Required<RemoveStockInput> {
  @ValidateIf(SET) @IsUUID() placeId!: string | null;
  @IsInt() @Min(1) @Max(MOST_STOCK_QUANTITY) quantity!: number;
  @IsIn(STOCK_REMOVAL_REASONS) reason!: StockRemovalReason;
  @ValidateIf(SET) @IsString() @MaxLength(500) note!: string | null;
  @IsUUID() requestKey!: string;
}

/** An item code deleted (2026-11-24), its code typed to confirm. */
export class DeleteStockItemDto implements Required<DeleteStockItemInput> {
  @IsIn(STOCK_ITEM_DELETE_REASONS) reason!: StockItemDeleteReason;
  @ValidateIf(SET) @IsString() @MaxLength(500) note!: string | null;
  @IsString() @MinLength(1) @MaxLength(40) confirmCode!: string;
}

export class SaveStockPlaceDto implements Required<SaveStockPlaceInput> {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name!: string;
  /** In either case; the service keeps it in capitals and says what shape it must be. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) code!: string;
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

/** Whoever may keep any code list: each list's own keeper is checked in the service. */
const KEEPER_ROUTE_PERMISSIONS = KEEPER_PERMISSIONS as PermissionKey[];
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
  // Kept by the role Purchasing Setup gives this list (2026-11-21); the service checks which.
  @RequireAnyPermission(...KEEPER_ROUTE_PERMISSIONS)
  createItem(@Req() request: AuthenticatedRequest, @Body() body: SaveStockItemDto) {
    return this.inventory.createItem(request.user, body);
  }

  @Get('items/:itemId')
  @RequirePermissions('inventory:read')
  item(@Req() request: AuthenticatedRequest, @Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.inventory.item(request.user, itemId);
  }

  @Patch('items/:itemId')
  // Kept by the role Purchasing Setup gives this list (2026-11-21); the service checks which.
  @RequireAnyPermission(...KEEPER_ROUTE_PERMISSIONS)
  updateItem(@Req() request: AuthenticatedRequest, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() body: SaveStockItemDto) {
    return this.inventory.updateItem(request.user, itemId, body);
  }

  @Post('items/:itemId/opening-balance')
  @RequirePermissions('inventory:manage')
  enterOpeningBalance(@Req() request: AuthenticatedRequest, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() body: OpeningBalanceDto) {
    return this.inventory.enterOpeningBalance(request.user, itemId, body);
  }

  /** Stock off the books with a reason: a REMOVAL movement, which Reverse puts back (2026-11-24). */
  @Post('items/:itemId/remove')
  @RequirePermissions('inventory:manage')
  removeStock(@Req() request: AuthenticatedRequest, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() body: RemoveStockDto) {
    return this.inventory.removeStock(request.user, itemId, body);
  }

  /** What deleting the item would do, read before the office confirms it. Item codes' keepers only; the service checks. */
  @Get('items/:itemId/deletion')
  @RequirePermissions('inventory:manage')
  deletion(@Req() request: AuthenticatedRequest, @Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.inventory.deletion(request.user, itemId);
  }

  /** Deletes the item code, its stock removed first. Item codes' keepers only; the service checks. */
  @Delete('items/:itemId')
  @RequirePermissions('inventory:manage')
  deleteItem(@Req() request: AuthenticatedRequest, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() body: DeleteStockItemDto) {
    return this.inventory.deleteItem(request.user, itemId, body);
  }

  @Post('movements/:movementId/reverse')
  @RequirePermissions('inventory:manage')
  reverseMovement(@Req() request: AuthenticatedRequest, @Param('movementId', ParseUUIDPipe) movementId: string, @Body() body: ReverseMovementDto) {
    return this.inventory.reverseMovement(request.user, movementId, body);
  }

  @Post('categories')
  // Kept by the role Purchasing Setup gives this list (2026-11-21); the service checks which.
  @RequireAnyPermission(...KEEPER_ROUTE_PERMISSIONS)
  createCategory(@Req() request: AuthenticatedRequest, @Body() body: SaveStockCategoryDto) {
    return this.inventory.createCategory(request.user, body);
  }

  @Patch('categories/:categoryId')
  // Kept by the role Purchasing Setup gives this list (2026-11-21); the service checks which.
  @RequireAnyPermission(...KEEPER_ROUTE_PERMISSIONS)
  updateCategory(@Req() request: AuthenticatedRequest, @Param('categoryId', ParseUUIDPipe) categoryId: string, @Body() body: SaveStockCategoryDto) {
    return this.inventory.updateCategory(request.user, categoryId, body);
  }

  @Get('places')
  @RequirePermissions('inventory:read')
  places(@Req() request: AuthenticatedRequest) {
    return this.inventory.places(request.user);
  }

  @Post('places')
  // Kept by the role Purchasing Setup gives this list (2026-11-21); the service checks which.
  @RequireAnyPermission(...KEEPER_ROUTE_PERMISSIONS)
  createPlace(@Req() request: AuthenticatedRequest, @Body() body: SaveStockPlaceDto) {
    return this.inventory.createPlace(request.user, body);
  }

  @Patch('places/:placeId')
  // Kept by the role Purchasing Setup gives this list (2026-11-21); the service checks which.
  @RequireAnyPermission(...KEEPER_ROUTE_PERMISSIONS)
  updatePlace(@Req() request: AuthenticatedRequest, @Param('placeId', ParseUUIDPipe) placeId: string, @Body() body: SaveStockPlaceDto) {
    return this.inventory.updatePlace(request.user, placeId, body);
  }

  @Get('vendors')
  @RequirePermissions('inventory:read')
  vendors(@Req() request: AuthenticatedRequest) {
    return this.inventory.vendors(request.user);
  }

  @Post('vendors')
  // Kept by the role Purchasing Setup gives this list (2026-11-21); the service checks which.
  @RequireAnyPermission(...KEEPER_ROUTE_PERMISSIONS)
  createVendor(@Req() request: AuthenticatedRequest, @Body() body: SaveVendorDto) {
    return this.inventory.createVendor(request.user, body);
  }

  @Patch('vendors/:vendorId')
  // Kept by the role Purchasing Setup gives this list (2026-11-21); the service checks which.
  @RequireAnyPermission(...KEEPER_ROUTE_PERMISSIONS)
  updateVendor(@Req() request: AuthenticatedRequest, @Param('vendorId', ParseUUIDPipe) vendorId: string, @Body() body: SaveVendorDto) {
    return this.inventory.updateVendor(request.user, vendorId, body);
  }
}
