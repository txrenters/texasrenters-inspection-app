import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  MOST_REQUISITION_LINES,
  MOST_STOCK_QUANTITY,
  MOST_UNIT_COST_CENTS,
  VENDOR_PAYMENT_METHODS,
  type ApproveVendorBillInput,
  type CloseShortInput,
  type PayVendorBillInput,
  type ReceiveGoodsInput,
  type ReverseReceiptInput,
  type SaveVendorBillInput,
  type VendorPaymentMethod,
} from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { PurchaseReceivingService } from './purchase-receiving.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Present and null clears the field; left out leaves it alone. */
const SET = (_: object, value: unknown) => value !== null && value !== undefined;
/** A bill past this is a typo: $1,000,000.00. */
const MOST_CENTS = 100_000_000;

export class ReceiptLineDto {
  @IsUUID() orderLineId!: string;
  @IsUUID() placeId!: string;
  @IsInt() @Min(1) @Max(MOST_STOCK_QUANTITY) quantity!: number;
}

/**
 * Every field of each contract input is named in its DTO: the validation pipe
 * refuses any field it does not know (purchase-receiving.spec.ts runs the pipe).
 */
export class ReceiveGoodsDto implements Required<ReceiveGoodsInput> {
  @IsOptional() @Matches(DAY) receivedOn!: string;
  @ValidateIf(SET) @IsString() @MaxLength(80) packingSlip!: string | null;
  @ValidateIf(SET) @IsString() @MaxLength(500) note!: string | null;
  @IsUUID() requestKey!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MOST_REQUISITION_LINES) @ValidateNested({ each: true }) @Type(() => ReceiptLineDto) lines!: ReceiptLineDto[];
}

export class ReverseReceiptDto implements Required<ReverseReceiptInput> {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class VendorBillLineDto {
  @IsUUID() orderLineId!: string;
  @IsInt() @Min(1) @Max(MOST_STOCK_QUANTITY) quantity!: number;
  @IsInt() @Min(0) @Max(MOST_UNIT_COST_CENTS) unitPriceCents!: number;
}

export class SaveVendorBillDto implements Required<SaveVendorBillInput> {
  @IsString() @MinLength(1) @MaxLength(80) billNumber!: string;
  @Matches(DAY) billDate!: string;
  @IsInt() @Min(0) @Max(MOST_CENTS) totalCents!: number;
  @IsArray() @ArrayMaxSize(MOST_REQUISITION_LINES) @ValidateNested({ each: true }) @Type(() => VendorBillLineDto) lines!: VendorBillLineDto[];
}

export class ApproveVendorBillAnywayDto implements Required<ApproveVendorBillInput> {
  @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
}

export class PayVendorBillDto implements Required<PayVendorBillInput> {
  @Matches(DAY) paidOn!: string;
  @IsIn(VENDOR_PAYMENT_METHODS) method!: VendorPaymentMethod;
  @ValidateIf(SET) @IsString() @MaxLength(80) reference!: string | null;
}

export class CloseShortDto implements Required<CloseShortInput> {
  @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
}

/**
 * Receiving and the vendor's bill (2026-11-19, phase 4). `purchasing:request`
 * opens Purchasing and is on every route. Posting and reversing a receipt add
 * `purchasing:receive`; the bill and its payment add `purchasing:bills`;
 * approving a bill that does not match adds `purchasing:approve-any`;
 * finishing an order short is the purchaser's. No API key may hold any of
 * them.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/purchasing')
export class PurchaseReceivingController {
  constructor(@Inject(PurchaseReceivingService) private readonly receiving: PurchaseReceivingService) {}

  @Post('orders/:orderId/receipts')
  @RequirePermissions('purchasing:request', 'purchasing:receive')
  @HttpCode(200)
  receive(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() body: ReceiveGoodsDto) {
    return this.receiving.receive(request.user, orderId, body);
  }

  @Post('receipts/:receiptId/reverse')
  @RequirePermissions('purchasing:request', 'purchasing:receive')
  @HttpCode(200)
  reverseReceipt(@Req() request: AuthenticatedRequest, @Param('receiptId', ParseUUIDPipe) receiptId: string, @Body() body: ReverseReceiptDto) {
    return this.receiving.reverseReceipt(request.user, receiptId, body);
  }

  @Post('orders/:orderId/close-short')
  @RequirePermissions('purchasing:request', 'purchasing:order')
  @HttpCode(200)
  closeShort(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() body: CloseShortDto) {
    return this.receiving.closeShort(request.user, orderId, body);
  }

  @Put('orders/:orderId/bill')
  @RequirePermissions('purchasing:request', 'purchasing:bills')
  saveBill(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() body: SaveVendorBillDto) {
    return this.receiving.saveBill(request.user, orderId, body);
  }

  @Post('orders/:orderId/bill/approve')
  @RequirePermissions('purchasing:request', 'purchasing:bills')
  @HttpCode(200)
  approveBill(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.receiving.approveBill(request.user, orderId);
  }

  @Post('orders/:orderId/bill/approve-anyway')
  @RequirePermissions('purchasing:request', 'purchasing:approve', 'purchasing:approve-any')
  @HttpCode(200)
  approveBillAnyway(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() body: ApproveVendorBillAnywayDto) {
    return this.receiving.approveBillAnyway(request.user, orderId, body);
  }

  @Post('orders/:orderId/bill/pay')
  @RequirePermissions('purchasing:request', 'purchasing:bills')
  @HttpCode(200)
  payBill(@Req() request: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() body: PayVendorBillDto) {
    return this.receiving.payBill(request.user, orderId, body);
  }
}
