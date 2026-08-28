import { Module } from '@nestjs/common';

import { TechnicianEventsGateway } from './technician-events.gateway';
import { MobilePushService } from './mobile-push.service';
import { PresenceService } from './presence.service';

@Module({
  providers: [MobilePushService, PresenceService, TechnicianEventsGateway],
  exports: [MobilePushService, PresenceService, TechnicianEventsGateway],
})
export class RealtimeModule {}
