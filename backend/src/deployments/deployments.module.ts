import { Module } from '@nestjs/common';

import { DeployRequestController } from './deploy-request.controller';
import { DeployRequestService } from './deploy-request.service';
import { GithubActionsKeys } from './github-actions-token';

@Module({
  controllers: [DeployRequestController],
  providers: [
    DeployRequestService,
    // A factory, because the keys take a fetcher and a clock that tests replace.
    { provide: GithubActionsKeys, useFactory: () => new GithubActionsKeys() },
  ],
})
export class DeploymentsModule {}
