import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MOST_ASK_LINES, MOST_SLIP_LINES, MOST_STOCK_QUANTITY, PHONE_SLIP_KINDS, UserRole, type AskForTruckStockInput, type PhoneSlipKind, type RecordJobStockInput } from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, Roles, RolesGuard, type AuthenticatedRequest } from '../common/auth';
import { TechnicianStockService } from './technician-stock.service';

export class JobStockLineDto {
  @IsUUID() itemId!: string;
  @IsInt() @Min(1) @Max(MOST_STOCK_QUANTITY) quantity!: number;
}

/**
 * Every field of the contract input is named: the validation pipe refuses any
 * field it does not know. There is no technician, job, day or cost in it: the
 * phone cannot say whose slip it is or what it is worth.
 */
export class RecordJobStockDto implements Required<RecordJobStockInput> {
  @IsIn(PHONE_SLIP_KINDS) kind!: PhoneSlipKind;
  @IsUUID() placeId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MOST_SLIP_LINES) @ValidateNested({ each: true }) @Type(() => JobStockLineDto) lines!: JobStockLineDto[];
  /** The phone's own key for the slip: the same letters and length its other keys use. */
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,128}$/u) clientRequestId!: string;
}

/** Ask the office for more (2026-11-24): the truck, the lines and a note. Who asks comes from the sign-in. */
export class AskForTruckStockDto implements Required<AskForTruckStockInput> {
  @IsUUID() placeId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MOST_ASK_LINES) @ValidateNested({ each: true }) @Type(() => JobStockLineDto) lines!: JobStockLineDto[];
  @ValidateIf((_: object, value: unknown) => value !== null) @IsString() @MaxLength(500) note!: string | null;
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,128}$/u) clientRequestId!: string;
}

/**
 * A job's materials on the phone (2026-11-19, phase 7). For signed-in
 * technicians only, as every phone route is; whose job it is, and which truck
 * may be used, are checked in the service.
 */
@ApiTags('Technician mobile application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, RolesGuard)
@Roles(UserRole.INSPECTION_TECHNICIAN)
@Controller('technician')
export class TechnicianStockController {
  constructor(@Inject(TechnicianStockService) private readonly stock: TechnicianStockService) {}

  @Get('inspections/:inspectionId/stock')
  forJob(@Req() request: AuthenticatedRequest, @Param('inspectionId', ParseUUIDPipe) inspectionId: string) {
    return this.stock.forJob(request.user, inspectionId);
  }

  @Post('inspections/:inspectionId/stock')
  @HttpCode(200)
  record(@Req() request: AuthenticatedRequest, @Param('inspectionId', ParseUUIDPipe) inspectionId: string, @Body() body: RecordJobStockDto) {
    return this.stock.record(request.user, inspectionId, body);
  }

  /** My truck (2026-11-24): what is on the technician's trucks, what has run low, their asks and latest slips. */
  @Get('truck')
  myTrucks(@Req() request: AuthenticatedRequest) {
    return this.stock.myTrucks(request.user);
  }

  /** Ask the office for more for one of their trucks. It moves no stock. */
  @Post('truck/asks')
  @HttpCode(200)
  ask(@Req() request: AuthenticatedRequest, @Body() body: AskForTruckStockDto) {
    return this.stock.ask(request.user, body);
  }
}
