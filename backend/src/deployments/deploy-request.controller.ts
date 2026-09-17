import { Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';

import { DeployRequestService } from './deploy-request.service';

/**
 * Called by the *Publish images* workflow once a release's images are in the
 * registry, so the server deploys them now rather than at its next check.
 *
 * Unauthenticated in the session sense, like the Jobber webhook: the caller is
 * a GitHub Actions job. What authorizes it is the OpenID Connect token GitHub
 * signs for that job, checked in DeployRequestService.
 */
@ApiTags('Deployments')
@Controller('deploy-requests')
export class DeployRequestController {
  constructor(@Inject(DeployRequestService) private readonly deploys: DeployRequestService) {}

  @Post()
  @HttpCode(202)
  @ApiExcludeEndpoint()
  request(@Headers('authorization') authorization?: string) {
    return this.deploys.request(authorization);
  }
}
