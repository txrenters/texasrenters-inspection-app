import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MOST_KEEP_AT_LEAST, MOST_KEEP_LEVELS, type SaveTruckKeepLevelsInput } from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsUUID, Max, Min, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { TruckStockService } from './truck-stock.service';

/** Null is "none"; anything else is checked. */
const GIVEN = (_: object, value: unknown) => value !== null;

export class TruckKeepLevelDto {
  @IsUUID() itemId!: string;
  @ValidateIf(GIVEN) @IsInt() @Min(0) @Max(MOST_KEEP_AT_LEAST) keepAtLeast!: number | null;
}

/** Every field of the contract input is named: the validation pipe refuses any field it does not know. */
export class SaveTruckKeepLevelsDto implements Required<SaveTruckKeepLevelsInput> {
  @IsArray() @ArrayMaxSize(MOST_KEEP_LEVELS) @ValidateNested({ each: true }) @Type(() => TruckKeepLevelDto) levels!: TruckKeepLevelDto[];
}

/**
 * The trucks on the console (2026-11-24): asks from the trucks, read with
 * `inventory:read` and filled by posting a move (`inventory:withdraw`, on the
 * slips route); what is kept on a truck, set with `inventory:manage`. No API
 * key may hold either of those two.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/inventory')
export class TruckStockController {
  constructor(@Inject(TruckStockService) private readonly trucks: TruckStockService) {}

  @Get('truck-asks')
  @RequirePermissions('inventory:read')
  asks(@Req() request: AuthenticatedRequest) {
    return this.trucks.asks(request.user);
  }

  @Get('places/:placeId/keep')
  @RequirePermissions('inventory:read')
  keepLevels(@Req() request: AuthenticatedRequest, @Param('placeId', ParseUUIDPipe) placeId: string) {
    return this.trucks.keepLevels(request.user, placeId);
  }

  @Put('places/:placeId/keep')
  @RequirePermissions('inventory:read', 'inventory:manage')
  saveKeepLevels(@Req() request: AuthenticatedRequest, @Param('placeId', ParseUUIDPipe) placeId: string, @Body() body: SaveTruckKeepLevelsDto) {
    return this.trucks.saveKeepLevels(request.user, placeId, body);
  }
}
