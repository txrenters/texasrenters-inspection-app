import { Module } from '@nestjs/common';

import { GoogleRoutesClient } from './google-routes.client';
import { MapboxDirectionsClient } from './mapbox-directions.client';
import { MapTilesClient } from './map-tiles.client';
import { OsrmClient } from './osrm.client';
import { RouteService } from './route.service';

/**
 * Route planning, kept in its own module.
 *
 * Exported rather than duplicated because two controllers ask the same
 * question from different sides: the console asks about a named technician's
 * day, and the technician asks about their own.
 *
 * The two routers are exported as well as the service, because the quarterly
 * planner needs a raw duration matrix for a *future* day — a question
 * `RouteService` cannot answer, since it starts from a technician's live GPS
 * ping and there is no such thing three months out.
 *
 * `MapTilesClient` lives here rather than in a module of its own because it
 * belongs to the same feature and holds the same kind of secret: it is the
 * basemap the drawn route is drawn *on*, and the reason it exists at all is
 * that the key it uses must never reach the handset. Exported so the
 * technician controller can proxy tiles to a phone that is already
 * authenticated against it.
 */
@Module({
  providers: [GoogleRoutesClient, MapboxDirectionsClient, MapTilesClient, OsrmClient, RouteService],
  exports: [GoogleRoutesClient, MapboxDirectionsClient, MapTilesClient, OsrmClient, RouteService],
})
export class RoutingModule {}
