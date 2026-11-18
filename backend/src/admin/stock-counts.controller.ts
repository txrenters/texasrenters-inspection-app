import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  MOST_COUNT_LINES,
  MOST_STOCK_QUANTITY,
  STOCK_COUNT_KINDS,
  STOCK_COUNT_REASONS,
  type CancelStockCountInput,
  type PostStockCountInput,
  type SaveStockCountInput,
  type StartStockCountInput,
  type StockCountKind,
  type StockCountReason,
} from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { StockCountsService } from './stock-counts.service';

/** Null is "none"; anything else is checked. */
const GIVEN = (_: object, value: unknown) => value !== null;

/**
 * Every field of each contract input is named in its DTO: the validation pipe
 * refuses any field it does not know (stock-counts.spec.ts runs the pipe).
 */
export class StartStockCountDto implements Required<StartStockCountInput> {
  @IsIn(STOCK_COUNT_KINDS) kind!: StockCountKind;
  @ValidateIf(GIVEN) @IsUUID() placeId!: string | null;
  @IsArray() @ArrayMaxSize(MOST_COUNT_LINES) @IsUUID(undefined, { each: true }) itemIds!: string[];
  @ValidateIf(GIVEN) @IsString() @MaxLength(500) note!: string | null;
  @IsUUID() requestKey!: string;
}

export class CountedLineDto {
  @IsUUID() lineId!: string;
  @ValidateIf(GIVEN) @IsInt() @Min(0) @Max(MOST_STOCK_QUANTITY) counted!: number | null;
}

export class SaveStockCountDto implements Required<SaveStockCountInput> {
  @IsArray() @ArrayMaxSize(MOST_COUNT_LINES) @ValidateNested({ each: true }) @Type(() => CountedLineDto) lines!: CountedLineDto[];
}

export class CountReasonDto {
  @IsUUID() lineId!: string;
  @IsIn(STOCK_COUNT_REASONS) reason!: StockCountReason;
}

export class PostStockCountDto implements Required<PostStockCountInput> {
  @IsArray() @ArrayMaxSize(MOST_COUNT_LINES) @ValidateNested({ each: true }) @Type(() => CountReasonDto) reasons!: CountReasonDto[];
}

export class CancelStockCountDto implements Required<CancelStockCountInput> {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

/**
 * Inventory counts (2026-11-19, phase 6). Read with `inventory:read`; started
 * and counted with `inventory:count` on top of it; reviewed and posted with
 * `inventory:count-approve`. No API key may hold either. What each person is
 * shown of a count, and may do to it, is decided in the service: the counter
 * never sees the expected numbers and never approves.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/inventory/counts')
export class StockCountsController {
  constructor(@Inject(StockCountsService) private readonly counts: StockCountsService) {}

  @Get()
  @RequirePermissions('inventory:read')
  list(@Req() request: AuthenticatedRequest) {
    return this.counts.list(request.user);
  }

  @Get('choices')
  @RequirePermissions('inventory:read', 'inventory:count')
  choices(@Req() request: AuthenticatedRequest) {
    return this.counts.choices(request.user);
  }

  @Post()
  @RequirePermissions('inventory:read', 'inventory:count')
  @HttpCode(200)
  start(@Req() request: AuthenticatedRequest, @Body() body: StartStockCountDto) {
    return this.counts.start(request.user, body);
  }

  @Get(':countId')
  @RequirePermissions('inventory:read')
  get(@Req() request: AuthenticatedRequest, @Param('countId', ParseUUIDPipe) countId: string) {
    return this.counts.get(request.user, countId);
  }

  @Put(':countId/counted')
  @RequirePermissions('inventory:read', 'inventory:count')
  save(@Req() request: AuthenticatedRequest, @Param('countId', ParseUUIDPipe) countId: string, @Body() body: SaveStockCountDto) {
    return this.counts.save(request.user, countId, body, false);
  }

  @Post(':countId/hand-in')
  @RequirePermissions('inventory:read', 'inventory:count')
  @HttpCode(200)
  handIn(@Req() request: AuthenticatedRequest, @Param('countId', ParseUUIDPipe) countId: string, @Body() body: SaveStockCountDto) {
    return this.counts.save(request.user, countId, body, true);
  }

  @Post(':countId/lines/:lineId/recount')
  @RequirePermissions('inventory:read', 'inventory:count-approve')
  @HttpCode(200)
  recount(@Req() request: AuthenticatedRequest, @Param('countId', ParseUUIDPipe) countId: string, @Param('lineId', ParseUUIDPipe) lineId: string) {
    return this.counts.recount(request.user, countId, lineId);
  }

  @Post(':countId/post')
  @RequirePermissions('inventory:read', 'inventory:count-approve')
  @HttpCode(200)
  post(@Req() request: AuthenticatedRequest, @Param('countId', ParseUUIDPipe) countId: string, @Body() body: PostStockCountDto) {
    return this.counts.post(request.user, countId, body);
  }

  /** The service decides who: an approver, or whoever started a count nobody has counted yet. */
  @Post(':countId/cancel')
  @RequirePermissions('inventory:read')
  @HttpCode(200)
  cancel(@Req() request: AuthenticatedRequest, @Param('countId', ParseUUIDPipe) countId: string, @Body() body: CancelStockCountDto) {
    return this.counts.cancel(request.user, countId, body);
  }
}
