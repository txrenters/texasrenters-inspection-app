import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  MOST_REQUISITION_LINES,
  MOST_STOCK_QUANTITY,
  MOST_TAX_BASIS_POINTS,
  MOST_UNIT_COST_CENTS,
  type CancelPurchaseOrderInput,
  type PurchaseOrderDecisionInput,
  type PurchaseOrderLineInput,
  type SavePurchaseOrderInput,
  type SendPurchaseOrderInput,
} from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBase64, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { PurchaseOrdersService } from './purchase-orders.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Null is "none"; anything else is checked. The form sends the whole order, so every field is there. */
const GIVEN = (_: object, value: unknown) => value !== null;

export class PurchaseOrderLineDto implements Required<PurchaseOrderLineInput> {
  @IsUUID() itemId!: string;
  @IsInt() @Min(1) @Max(MOST_STOCK_QUANTITY) quantity!: number;
  @IsInt() @Min(0) @Max(MOST_UNIT_COST_CENTS) unitPriceCents!: number;
}

/**
 * Every field of each contract input is named in its DTO: the validation pipe
 * refuses any field it does not know (purchase-orders.spec.ts runs the pipe).
 */
export class SavePurchaseOrderDto implements Required<SavePurchaseOrderInput> {
  @ValidateIf(GIVEN) @IsUUID() vendorId!: string | null;
  @ValidateIf(GIVEN) @IsUUID() deliverToPlaceId!: string | null;
  @ValidateIf(GIVEN) @Matches(DAY) expectedOn!: string | null;
  @ValidateIf(GIVEN) @IsString() @MaxLength(60) terms!: string | null;
  @IsInt() @Min(0) @Max(MOST_TAX_BASIS_POINTS) taxBasisPoints!: number;
  @ValidateIf(GIVEN) @IsString() @MaxLength(2000) notes!: string | null;
  @IsArray() @ArrayMaxSize(MOST_REQUISITION_LINES) @ValidateNested({ each: true }) @Type(() => PurchaseOrderLineDto) lines!: PurchaseOrderLineDto[];
}

export class PurchaseOrderDecisionDto implements Required<PurchaseOrderDecisionInput> {
  @IsOptional() @IsString() @MaxLength(1000) note!: string | null;
}

export class CancelPurchaseOrderDto implements Required<CancelPurchaseOrderInput> {
  @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
}

export class PurchaseOrderAttachmentDto {
  @IsString() @MinLength(1) @MaxLength(200) fileName!: string;
  /** About 200 kB of PDF as base64; the service checks the bytes. */
  @IsBase64() @MaxLength(280_000) contentBase64!: string;
}

export class SendPurchaseOrderDto implements Required<SendPurchaseOrderInput> {
  @IsEmail() @MaxLength(320) to!: string;
  @IsOptional() @IsString() @MaxLength(2000) message!: string | null;
  @ValidateNested() @Type(() => PurchaseOrderAttachmentDto) attachment!: PurchaseOrderAttachmentDto;
  @IsUUID() clientRequestId!: string;
}

export class PurchaseOrderListQueryDto {
  @IsOptional() @IsIn(['open', 'closed']) show?: 'open' | 'closed';
}

/**
 * Purchase orders (2026-11-19, phase 3). `purchasing:request` opens
 * Purchasing and is on every route; making, changing, sending and cancelling
 * an order add `purchasing:order`; approving one adds `purchasing:approve`.
 * No API key may hold any of them. Whose order a caller may see, and how much
 * they may approve, is decided in the service.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/purchasing')
export class PurchaseOrdersController {
  constructor(@Inject(PurchaseOrdersService) private readonly orders: PurchaseOrdersService) {}

  @Get('orders')
  @RequirePermissions('purchasing:request')
  list(@Req() request: AuthenticatedRequest, @Query() query: PurchaseOrderListQueryDto) {
    return this.orders.list(request.user, query.show ?? 'open');
  }

  /** Requests to Approve (2026-11-21): the orders waiting that the caller, a purchasing manager, may approve. Before the id route. */
  @Get('orders/to-approve')
  @RequirePermissions('purchasing:request')
  toApprove(@Req() request: AuthenticatedRequest) {
    return this.orders.toApprove(request.user);
  }

  @Post('requisitions/:requisitionId/order')
  @RequirePermissions('purchasing:request', 'purchasing:order')
  create(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string) {
    return this.orders.createFromRequisition(request.user, requisitionId);
  }

  @Get('orders/:orderId')
  @RequirePermissions('purchasing:request')
  detail(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.orders.detail(request.user, orderId);
  }

  @Put('orders/:orderId')
  @RequirePermissions('purchasing:request', 'purchasing:order')
  update(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() body: SavePurchaseOrderDto) {
    return this.orders.update(request.user, orderId, body);
  }

  @Post('orders/:orderId/submit')
  @RequirePermissions('purchasing:request', 'purchasing:order')
  @HttpCode(200)
  submit(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.orders.submit(request.user, orderId);
  }

  @Post('orders/:orderId/approve')
  @RequirePermissions('purchasing:request', 'purchasing:approve-orders')
  @HttpCode(200)
  approve(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() body: PurchaseOrderDecisionDto) {
    return this.orders.decide(request.user, orderId, 'APPROVED', body);
  }

  @Post('orders/:orderId/send-back')
  @RequirePermissions('purchasing:request', 'purchasing:approve-orders')
  @HttpCode(200)
  sendBack(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() body: PurchaseOrderDecisionDto) {
    return this.orders.decide(request.user, orderId, 'SENT_BACK', body);
  }

  @Post('orders/:orderId/cancel')
  @RequirePermissions('purchasing:request', 'purchasing:order')
  @HttpCode(200)
  cancel(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() body: CancelPurchaseOrderDto) {
    return this.orders.cancel(request.user, orderId, body);
  }

  @Post('orders/:orderId/send')
  @RequirePermissions('purchasing:request', 'purchasing:order')
  @HttpCode(200)
  send(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() body: SendPurchaseOrderDto) {
    return this.orders.send(request.user, orderId, body);
  }
}
