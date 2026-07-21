import { Module } from '@nestjs/common';

import { TechnicianEventsGateway } from './technician-events.gateway';
import { MobilePushService } from './mobile-push.service';

@Module({
  providers: [MobilePushService, TechnicianEventsGateway],
  exports: [MobilePushService, TechnicianEventsGateway],
})
export class RealtimeModule {}
