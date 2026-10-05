/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import {
  ApiAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedRequest,
} from '../common/auth';
import { AdjustSegmentDto, RecalculateDto, TimesheetQueryDto } from './time-tracking.dto';
import { TimeTrackingService } from './time-tracking.service';

export const TIME_TRACKING_TAG = 'Time tracking';

@ApiTags(TIME_TRACKING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/time-tracking')
export class TimeTrackingController {
  constructor(@Inject(TimeTrackingService) private readonly time: TimeTrackingService) {}

  /**
   * Read every technician's days in a range from the trail again.
   *
   * Today and yesterday are read without anybody asking. This is for the days
   * behind them: after the rule changes, or after a property's pin or radius
   * is corrected. It writes hours and nothing else, hours somebody corrected
   * by hand are left alone, and running it twice gives the same answer.
   *
   * `inspections:manage` rather than a read permission, because it does write.
   */
  @Post('recalculate')
  @RequirePermissions('inspections:manage')
  @HttpCode(200)
  recalculate(@Req() request: AuthenticatedRequest, @Body() body: RecalculateDto) {
    return this.time.recalculate(request.user, body);
  }

  /**
   * What each technician is owed for a stretch of days.
   *
   * A read, so `inspections:read` -- the office looks at this far more often
   * than it changes anything, and a permission that made looking expensive
   * would push people back to asking the technician.
   */
  @Get('timesheet')
  @RequirePermissions('inspections:read')
  timesheet(@Req() request: AuthenticatedRequest, @Query() query: TimesheetQueryDto) {
    return this.time.timesheet(request.user, query);
  }

  /**
   * Correct a segment the trail got wrong.
   *
   * Admin-only and always with a reason. A technician cannot edit their own
   * time -- that is the self-reporting this feature replaces -- but the office
   * can, and every correction keeps what it replaced.
   */
  @Patch('segments/:segmentId')
  @RequirePermissions('inspections:manage')
  adjust(
    @Req() request: AuthenticatedRequest,
    @Param('segmentId') segmentId: string,
    @Body() body: AdjustSegmentDto,
  ) {
    return this.time.adjustSegment(request.user, segmentId, body);
  }
}
