import { Module } from '@nestjs/common';

import { OsrmClient } from './osrm.client';
import { RouteService } from './route.service';

/**
 * Route planning, kept in its own module.
 *
 * Exported rather than duplicated because two controllers ask the same
 * question from different sides: the console asks about a named technician's
 * day, and the technician asks about their own.
 */
@Module({
  providers: [OsrmClient, RouteService],
  exports: [RouteService],
})
export class RoutingModule {}
