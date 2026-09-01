import { Module } from '@nestjs/common';

import { ApiAuthGuard, PermissionsGuard } from '../../common/auth';
import { JobberOutboundWorker } from '../../workers/jobber-sync/jobber-outbound.worker';
import { JobberSyncScheduler } from '../../workers/jobber-sync/jobber-sync.scheduler';
import { JobberSyncWorker } from '../../workers/jobber-sync/jobber-sync.worker';
import { JobberClient } from './jobber.client';
import { JOBBER_CONFIG, getJobberConfig } from './jobber.config';
import { JobberIntegrationController, JobberOAuthCallbackController } from './jobber.controller';
import { JobberWebhookController } from './jobber.webhook.controller';
import { JobberWebhookGuard } from './jobber-webhook.guard';
import { JobberWebhookService } from './jobber.webhook.service';
import { JobberMappingService } from './jobber.mapping.service';
import { JobberOAuthService } from './jobber.oauth.service';
import { JobberService } from './jobber.service';
import { JobberTokenService } from './jobber.tokens.service';

@Module({
  controllers: [JobberIntegrationController, JobberOAuthCallbackController, JobberWebhookController],
  providers: [
    { provide: JOBBER_CONFIG, useFactory: getJobberConfig },
    JobberTokenService,
    JobberOAuthService,
    JobberClient,
    JobberMappingService,
    JobberService,
    JobberSyncWorker,
    JobberOutboundWorker,
    JobberWebhookService,
    JobberWebhookGuard,
    JobberSyncScheduler,
    ApiAuthGuard,
    PermissionsGuard,
  ],
  exports: [JobberClient, JobberTokenService, JobberMappingService, JobberSyncWorker, JobberOutboundWorker],
})
export class JobberModule {}
