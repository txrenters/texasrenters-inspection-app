import { Global, Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import { TechnicianModule } from '../technician/technician.module';
import { ApiAuthGuard, PermissionsGuard } from '../common/auth';
import { ApiClientController } from './api-client.controller';
import { GatewayController } from './gateway.controller';
import { ApiClientService } from './api-client.service';
import { ApiKeyGuard } from './api-key.guard';
import { GatewayAuthGuard } from './gateway-auth.guard';
import { ApiRateLimitGuard } from './rate-limit.guard';

/**
 * Third-party API access: the registration console behind `system:manage`, and
 * the guards that authenticate, authorize and rate-limit machine callers.
 *
 * Global because `GatewayAuthGuard` and `ApiRateLimitGuard` are applied by
 * feature modules that have no other reason to know this module exists — a
 * controller opening a route to integrations should need one `@UseGuards`, not
 * an import graph change.
 */
@Global()
@Module({
  // TechnicianModule for the position feed the map and any dispatching
  // integration read; AdminModule for everything else on the gateway surface.
  imports: [AdminModule, TechnicianModule],
  controllers: [ApiClientController, GatewayController],
  providers: [
    ApiClientService,
    ApiKeyGuard,
    ApiAuthGuard,
    GatewayAuthGuard,
    ApiRateLimitGuard,
    PermissionsGuard,
  ],
  exports: [ApiClientService, ApiKeyGuard, GatewayAuthGuard, ApiRateLimitGuard],
})
export class GatewayModule {}
