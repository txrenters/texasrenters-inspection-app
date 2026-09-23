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
import {
  AdjustSegmentDto,
  FillHoursDto,
  ResolveGapDto,
  TimesheetQueryDto,
} from './time-tracking.dto';
import { TimeTrackingService } from './time-tracking.service';

export const TIME_TRACKING_TAG = 'Time tracking';

@ApiTags(TIME_TRACKING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/time-tracking')
export class TimeTrackingController {
  constructor(@Inject(TimeTrackingService) private readonly time: TimeTrackingService) {}

  /**
   * Read a job's time from the trail again.
   *
   * Asked for rather than automatic while the manual buttons are still the
   * source of an invoice: the office runs it to see what the tracker makes of a
   * job, beside what Start and End said. It writes segments and nothing else --
   * no invoice, no pay -- so running it is safe at any time, and running it
   * twice produces the same answer.
   *
   * `inspections:manage` rather than a read permission, because it does write.
   */
  @Post('inspections/:inspectionId/recompute')
  @RequirePermissions('inspections:manage')
  @HttpCode(200)
  recompute(@Req() request: AuthenticatedRequest, @Param('inspectionId') inspectionId: string) {
    return this.time.recomputeForInspection(request.user, inspectionId);
  }

  /**
   * Read the hours of jobs in this range that have none.
   *
   * For the jobs that were submitted before any of this existed, and for
   * anything the sweep could not reach. It only fills where there is nothing,
   * so it cannot move an hour somebody has already been paid for.
   *
   * `inspections:manage`, like the single-job recompute: it writes.
   */
  @Post('fill-hours')
  @RequirePermissions('inspections:manage')
  @HttpCode(200)
  fillHours(@Req() request: AuthenticatedRequest, @Body() body: FillHoursDto) {
    return this.time.fillMissingHours(request.user, body);
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

  /** Settle a stretch the trail could not account for, crediting the time or not. */
  @Post('gaps/:gapId/resolve')
  @RequirePermissions('inspections:manage')
  @HttpCode(200)
  resolveGap(
    @Req() request: AuthenticatedRequest,
    @Param('gapId') gapId: string,
    @Body() body: ResolveGapDto,
  ) {
    return this.time.resolveGap(request.user, gapId, body);
  }
}
