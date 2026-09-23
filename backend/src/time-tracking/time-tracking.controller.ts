/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import {
  ApiAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedRequest,
} from '../common/auth';
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
}
