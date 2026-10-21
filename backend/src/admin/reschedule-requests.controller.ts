import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  MAX_RESCHEDULE_REASON,
  RESCHEDULE_REQUEST_FILTERS,
  type RescheduleRequestFilter,
} from '@texasrenters/shared';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { RescheduleRequestsService } from './reschedule-requests.service';

export class RescheduleRequestListQueryDto {
  /** What is still with the office, or what was answered. */
  @IsOptional() @IsIn(RESCHEDULE_REQUEST_FILTERS) filter?: RescheduleRequestFilter;
}

export class MoveRescheduleRequestDto {
  /** The new day, `YYYY-MM-DD` in Texas. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/) scheduledOn!: string;
}

export class BookAgainRescheduleRequestDto {
  /** The day to book, `YYYY-MM-DD` in Texas. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/) scheduledOn!: string;
  /** Who goes: the visit's technician when left out, nobody when null. */
  @IsOptional() @IsUUID() technicianId?: string | null;
}

export class DismissRescheduleRequestDto {
  @IsString() @MinLength(3) @MaxLength(MAX_RESCHEDULE_REASON) reason!: string;
}

/**
 * The office's queue of visits to book again (2026-10-21).
 *
 * Listing and dismissing take either grant -- managing inspections or
 * publishing the plan -- which the service checks, as the guard requires all
 * the permissions it is given. Moving and booking change an inspection, so
 * they take `inspections:manage` here as well.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/reschedule-requests')
export class RescheduleRequestsController {
  constructor(@Inject(RescheduleRequestsService) private readonly service: RescheduleRequestsService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: RescheduleRequestListQueryDto) {
    return this.service.list(request.user, query.filter ?? 'open');
  }

  /** The visit to another day, here and in Jobber. */
  @Post(':requestId/move')
  @RequirePermissions('inspections:manage')
  move(
    @Req() request: AuthenticatedRequest,
    @Param('requestId', new ParseUUIDPipe()) id: string,
    @Body() body: MoveRescheduleRequestDto,
  ) {
    return this.service.move(request.user, id, body);
  }

  /** A new visit for what was not done, booked in Jobber when the first one was. */
  @Post(':requestId/book-again')
  @RequirePermissions('inspections:manage')
  bookAgain(
    @Req() request: AuthenticatedRequest,
    @Param('requestId', new ParseUUIDPipe()) id: string,
    @Body() body: BookAgainRescheduleRequestDto,
  ) {
    return this.service.bookAgain(request.user, id, body);
  }

  /** Not booked again, and why: a note goes on the Jobber job. */
  @Post(':requestId/dismiss')
  dismiss(
    @Req() request: AuthenticatedRequest,
    @Param('requestId', new ParseUUIDPipe()) id: string,
    @Body() body: DismissRescheduleRequestDto,
  ) {
    return this.service.dismiss(request.user, id, body);
  }
}
