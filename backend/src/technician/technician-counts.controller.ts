import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MOST_STOCK_QUANTITY, UserRole, type PhoneCountedLine, type SavePhoneCountInput } from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsUUID, Max, Min, ValidateNested } from 'class-validator';

import { ApiAuthGuard, Roles, RolesGuard, type AuthenticatedRequest } from '../common/auth';
import { TechnicianCountsService } from './technician-counts.service';

/** A truck holds far fewer kinds of item than this; it bounds one send. */
export const MOST_PHONE_COUNT_LINES = 500;

export class PhoneCountedLineDto implements Required<PhoneCountedLine> {
  @IsUUID() lineId!: string;
  @IsInt() @Min(0) @Max(MOST_STOCK_QUANTITY) counted!: number;
  @IsBoolean() second!: boolean;
}

/**
 * Every field of the contract input is named: the validation pipe refuses any
 * field it does not know. There is no counter, place, expected number or cost
 * in it: the phone cannot say whose count it is or what a line should hold.
 */
export class SavePhoneCountDto implements Required<SavePhoneCountInput> {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MOST_PHONE_COUNT_LINES) @ValidateNested({ each: true }) @Type(() => PhoneCountedLineDto) lines!: PhoneCountedLineDto[];
  @IsBoolean() handIn!: boolean;
}

/**
 * Counting a truck from the phone (2026-11-19). For signed-in technicians
 * only, as every phone route is; which truck, and whether the count is theirs
 * to count, are checked in the service.
 */
@ApiTags('Technician mobile application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, RolesGuard)
@Roles(UserRole.INSPECTION_TECHNICIAN)
@Controller('technician')
export class TechnicianCountsController {
  constructor(@Inject(TechnicianCountsService) private readonly counts: TechnicianCountsService) {}

  @Get('stock-counts')
  mine(@Req() request: AuthenticatedRequest) {
    return this.counts.mine(request.user);
  }

  @Post('stock-counts/:countId')
  @HttpCode(200)
  save(@Req() request: AuthenticatedRequest, @Param('countId', ParseUUIDPipe) countId: string, @Body() body: SavePhoneCountDto) {
    return this.counts.save(request.user, countId, body);
  }
}
