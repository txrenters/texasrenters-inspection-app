import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { TimeTrackingController } from './time-tracking.controller';
import { TimeTrackingScheduler } from './time-tracking.scheduler';
import { TimeTrackingService } from './time-tracking.service';

/**
 * Automatic time tracking, read from the technician trail.
 *
 * Deliberately its own module rather than a corner of `technician` or `admin`:
 * it is read by the office, written from a technician's movements, and destined
 * for invoicing, so it belongs to none of them.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [TimeTrackingController],
  providers: [TimeTrackingService, TimeTrackingScheduler],
  exports: [TimeTrackingService],
})
export class TimeTrackingModule {}
