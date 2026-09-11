import { Module } from '@nestjs/common';

import { GoogleRoutesClient } from './google-routes.client';
import { OsrmClient } from './osrm.client';
import { RouteService } from './route.service';

/**
 * Route planning, kept in its own module.
 *
 * Exported rather than duplicated because two controllers ask the same
 * question from different sides: the console asks about a named technician's
 * day, and the technician asks about their own.
 *
 * The two clients are exported as well as the service, because the quarterly
 * planner needs a raw duration matrix for a *future* day — a question
 * `RouteService` cannot answer, since it starts from a technician's live GPS
 * ping and there is no such thing three months out.
 */
@Module({
  providers: [GoogleRoutesClient, OsrmClient, RouteService],
  exports: [GoogleRoutesClient, OsrmClient, RouteService],
})
export class RoutingModule {}
