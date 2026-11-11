import { Module } from '@nestjs/common';

import { WorkOrderIntakeService } from './work-order-intake.service';

/**
 * Work orders handed over by the maintenance app. The route lives on the
 * gateway controller, where every third-party route is; this module only
 * provides what files them.
 */
@Module({
  providers: [WorkOrderIntakeService],
  exports: [WorkOrderIntakeService],
})
export class WorkOrdersModule {}
