'use client';

import type { PropertyPosition, TechnicianPosition } from '@texasrenters/shared';
import { ONLINE_WITHIN_MS } from '@texasrenters/shared';
import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import { Layer, Marker, Popup, Source, useMap } from 'react-map-gl/mapbox';

import {
  clusterByGrid,
  inBox,
  padBox,
  ringIsLegible,
  zoomToIsolate,
  type Box,
} from '@/components/map-clusters';
import { useMapStroke } from '@/components/map-colors';
import { circleFeature, featureCollection } from '@/components/map-geometry';
import { PropertyDotsLayer } from '@/components/map-layers';
import { Badge } from '@/components/ui/badge';
import { ClusterPin, DrivingPin, PropertyPin, TechnicianPin } from '@/components/map-pins';
import { useGlide } from '@/lib/map-animation';
import { drawsAsDriving, motionOf, type Motion } from '@/lib/technician-motion';
import { useMotionTracks } from '@/lib/use-motion-tracks';

/**
 * The portfolio and the crew, as every map in this console draws them.
 *
 * These were the technician map's own, and the quarter's maps drew something
 * else: different markers, a different idea of where a property is, and a
 * grouping radius around a different set of points. The office asked for one
 * map -- "same geocoding, same Venn diagram" -- and the way to have one map is
 * to have one set of layers, which is what this module is.
 *
 * Moved here unchanged. The technician map still draws with them, and so do
 * the plan's day map, its needs-attention map and its Groups tab.
 */

/** Past this, a position is history rather than an answer to "where are they". */
/**
 * Kept as a re-export so this file reads the same as it did, but the number
 * now lives in `shared` -- the roster list asks the same question, and two
 * thresholds would let the list say online while the pin said otherwise.
 */
export const STALE_AFTER_MS = ONLINE_WITHIN_MS;

/**
 * How far past the edge of the map markers are still drawn, as a share of the
 * view's size on each side -- so a short pan does not uncover an empty strip
 * that fills in only when the map settles.
 */
const DRAWN_BEYOND_VIEW = 0.5;

/**
 * The zoom and the visible area, as state, as of the last time the map settled.
 *
 * Grouping is worked out in projected pixels at the current zoom, so it changes
 * when the zoom does and never when panning — a clustering that reshuffled as
 * you dragged would read as the data itself moving. The visible area decides
 * which of those groups are drawn at all.
 */
/**
 * The zoom assumed before a map has said where it is looking.
 *
 * Only ever the first render's answer: the effect below reads the real zoom
 * as soon as the map exists. Country-wide, so the first grouping is the
 * cheapest one -- the whole portfolio as a handful of badges.
 */
const OPENING_ZOOM = 5;

export function useSettledView() {
  const { current: map } = useMap();
  const [view, setView] = useState<{ zoom: number; box: Box | null }>({
    zoom: OPENING_ZOOM,
    box: null,
  });

  useEffect(() => {
    if (!map) return;
    const sync = () =>
      setView((current) => {
        const zoom = map.getZoom() ?? current.zoom;
        const bounds = map.getBounds();
        const box = bounds
          ? {
              north: bounds.getNorth(),
              south: bounds.getSouth(),
              east: bounds.getEast(),
              west: bounds.getWest(),
            }
          : current.box;
        // The same view handed back, so a settle that changed nothing costs no
        // render at all.
        const unchanged =
          zoom === current.zoom &&
          box?.north === current.box?.north &&
          box?.south === current.box?.south &&
          box?.east === current.box?.east &&
          box?.west === current.box?.west;
        return unchanged ? current : { zoom, box };
      });
    sync();
    /**
     * `idle`, not `zoom` or `move`.
     *
     * Those fire on every frame of a scroll, pinch or drag, and each one
     * re-grouped the properties and reconciled every marker — mid-gesture,
     * several times a second. `idle` fires once, when the map has settled and
     * finished drawing, so the work happens exactly as often as the answer
     * actually changes.
     */
    map.on('idle', sync);
    return () => {
      map.off('idle', sync);
    };
  }, [map]);

  return view;
}

/**
 * The claimed accuracy, drawn to scale.
 *
 * A 5m fix and a 300m fix are very different statements, and a map that drew
 * them as the same dot would be asserting something nobody knows.
 *
 * One source for everybody reporting a vague fix, rather than one each: this
 * re-renders on every socket frame, and a source per technician is a source
 * added and removed on the map several times a second.
 */
export const AccuracyLayer = memo(function AccuracyLayer({
  positions,
}: {
  positions: readonly TechnicianPosition[];
}) {
  const data = useMemo(
    () =>
      featureCollection(
        positions
          .filter((position) => position.accuracyMeters && position.accuracyMeters > 25)
          .map((position) =>
            circleFeature(position.latitude, position.longitude, position.accuracyMeters!),
          ),
      ),
    [positions],
  );

  if (!data.features.length) return null;

  return (
    <Source data={data} id="accuracy" type="geojson">
      <Layer
        id="accuracy-fill"
        paint={{ 'fill-color': '#6b7280', 'fill-opacity': 0.1, 'fill-outline-color': '#6b7280' }}
        type="fill"
      />
    </Source>
  );
});

/** One property's two radii, as the geofence layer needs them. */
export interface GeofenceRing {
  id: string;
  latitude: number;
  longitude: number;
  enterRadiusMeters: number;
  exitRadiusMeters: number;
  dim: boolean;
}

/**
 * How close a technician has to be before the time counts as on site.
 *
 * Drawn because this is the number the hours are computed from, and until now
 * it existed only as a column. An office deciding whether a technician was
 * really at a property is reading a radius they cannot see against a building
 * they can — and a replay over 37 real jobs showed the geometry is not the
 * hard part, coverage is. Two circles, because the rule has two numbers: the
 * inner one is the distance that starts the clock, the outer one the distance
 * that has to be crossed before it stops. That gap is deliberate — it is what
 * keeps a technician standing still at the edge of a driveway from being
 * clocked in and out every time a fix wobbles — and drawing only one of them
 * would show a boundary the software does not actually have.
 *
 * Every ring in one source, painted from each shape's own properties. A source
 * per property meant a source added and torn down on every pan, for a shape
 * that is only drawn when somebody is already zoomed in close enough to read
 * it.
 */
export const GeofenceLayer = memo(function GeofenceLayer({ rings }: { rings: readonly GeofenceRing[] }) {
  const orange = useMapStroke('map-geofence-ring');
  const data = useMemo(
    () =>
      featureCollection(
        rings.flatMap((ring) => [
          circleFeature(ring.latitude, ring.longitude, ring.enterRadiusMeters, {
            kind: 'enter',
            dim: ring.dim ? 1 : 0,
          }),
          circleFeature(ring.latitude, ring.longitude, ring.exitRadiusMeters, {
            kind: 'exit',
            dim: ring.dim ? 1 : 0,
          }),
        ]),
      ),
    [rings],
  );

  if (!rings.length) return null;

  return (
    <Source data={data} id="geofence" type="geojson">
      {/* The inner circle only. Filling both would read as one solid blob whose
          edge is the outer number, which is the opposite of what the gap
          means. */}
      <Layer
        filter={['==', ['get', 'kind'], 'enter']}
        id="geofence-fill"
        paint={{
          'fill-color': orange,
          'fill-opacity': ['case', ['==', ['get', 'dim'], 1], 0.04, 0.12],
        }}
        type="fill"
      />
      <Layer
        id="geofence-outline"
        paint={{
          'line-color': orange,
          'line-width': ['case', ['==', ['get', 'kind'], 'enter'], 2, 1],
          'line-opacity': [
            'case',
            ['all', ['==', ['get', 'kind'], 'enter'], ['==', ['get', 'dim'], 0]],
            0.85,
            ['all', ['==', ['get', 'kind'], 'enter'], ['==', ['get', 'dim'], 1]],
            0.3,
            ['==', ['get', 'dim'], 1],
            0.15,
            0.4,
          ],
        }}
        type="line"
      />
    </Source>
  );
});

/**
 * Every property, grouped when the pins would overlap.
 *
 * Clustered because this is a portfolio of hundreds: drawn individually at
 * metropolitan zoom they merge into a green smear that reports neither where
 * the work is nor how much of it there is. Three Houston properties within 250m
 * already drew as one pin while the legend said three.
 *
 * **Only properties cluster.** Technicians are the thing being watched, and
 * folding two of them into a badge would hide exactly what somebody opened the
 * map to see.
 *
 * Memoised, and that is the single biggest thing on this map. Technician
 * positions arrive over the socket every few seconds, re-rendering this page
 * and everything under it. Without this, each of those frames reconciled ~40
 * cluster markers whose props had not changed — every one a real DOM element
 * the map repositions itself. None of this layer's props move when a
 * technician does.
 */
export const PropertyLayer = memo(function PropertyLayer({
  highlighted,
  properties,
  selectedPropertyId,
}: {
  /**
   * The selected technician's buildings, or null when nobody is selected.
   *
   * Null rather than an empty set, because the two mean opposite things: null
   * is "show everything at full strength", empty is "this person has no mapped
   * stops", and drawing those the same way would make a technician with no work
   * look like no selection at all.
   */
  highlighted: ReadonlySet<string> | null;
  properties: readonly PropertyPosition[];
  /** Picked from the list, so its own window opens without a second click. */
  selectedPropertyId: string | null;
}) {
  const { current: map } = useMap();
  const { zoom, box } = useSettledView();
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** The selection this layer last acted on, so churn is not mistaken for a change. */
  const lastSelected = useRef<string | null>(selectedPropertyId);

  const clusters = useMemo(() => clusterByGrid(properties, zoom), [properties, zoom]);

  /**
   * Only the groups on or near the screen are drawn.
   *
   * Every property used to be a marker all the time. At street level that is
   * every one of them standing alone -- 586 in production -- nearly all of them
   * miles off-screen, each a real element the map repositions on every frame of
   * a zoom. Scrolling the map in and out stuttered and froze for up to a
   * second. The grouping itself is unchanged: it is still worked out from the
   * zoom alone, so panning never reshuffles a badge.
   *
   * Until the map first reports where it is looking, everything is drawn --
   * which costs nothing, because the zoom used for grouping is still the
   * opening, country-wide one, where the whole portfolio is a handful of
   * badges. The open window's group stays drawn even when panned out of view,
   * so it does not close under the reader.
   */
  const drawn = useMemo(() => {
    if (!box) return clusters;
    const reach = padBox(box, DRAWN_BEYOND_VIEW);
    return clusters.filter((cluster) => cluster.key === openKey || inBox(cluster, reach));
  }, [box, clusters, openKey]);

  /**
   * The rings worth drawing: a property standing alone, and only once it is big
   * enough on screen to be a size rather than a smudge.
   *
   * A badge's coordinate is the average of what it holds, so a circle drawn
   * there would be centred on nobody's building.
   */
  const rings = useMemo<GeofenceRing[]>(
    () =>
      drawn.flatMap((cluster) => {
        const single = cluster.members.length === 1 ? cluster.members[0] : null;
        if (!single || !ringIsLegible(single.enterRadiusMeters, single.latitude, zoom)) return [];
        return [
          {
            id: single.id,
            latitude: single.latitude,
            longitude: single.longitude,
            enterRadiusMeters: single.enterRadiusMeters,
            exitRadiusMeters: single.exitRadiusMeters,
            dim: Boolean(highlighted && !highlighted.has(single.id)),
          },
        ];
      }),
    [drawn, highlighted, zoom],
  );

  /**
   * Opens the selected property's window once it is actually drawn.
   *
   * Depends on `clusters` as well as the selection, and that is the whole
   * trick: selecting flies the map in, the zoom change regroups the clusters,
   * and only then does the property stop being folded into a badge and get a
   * marker of its own. Running on the selection alone would fire while it was
   * still inside a cluster and find nothing to open.
   *
   * Falls back to the badge it is hiding in rather than opening nothing —
   * reached when no zoom separates them, which is two records at identical
   * coordinates. "It is here, with another" beats a click that looks lost.
   */
  useEffect(() => {
    const letGo = selectedPropertyId === null;
    const changed = selectedPropertyId !== lastSelected.current;
    lastSelected.current = selectedPropertyId;

    /**
     * **A window opened by clicking is not this effect's to close.**
     *
     * This ran on `clusters` as well as the selection and closed the window
     * whenever nothing was selected -- so a click on a pin opened its details
     * and the next refetch, which rebuilds the property list and with it the
     * clusters, closed them again. On the technician map that is every few
     * seconds, and the window was gone before it could be read. Reported as
     * markers that cannot be clicked at all, because that is what it looked
     * like.
     *
     * Only *letting go* of a selected property closes its window now; the
     * clusters changing underneath an open one leaves it alone.
     */
    if (letGo) {
      if (changed) setOpenKey(null);
      return;
    }

    const own = clusters.find(
      (cluster) => cluster.members.length === 1 && cluster.members[0].id === selectedPropertyId,
    );
    const group = clusters.find((cluster) =>
      cluster.members.some((member) => member.id === selectedPropertyId),
    );
    setOpenKey(own?.key ?? group?.key ?? null);
  }, [clusters, selectedPropertyId]);

  return (
    <>
      <GeofenceLayer rings={rings} />

      {drawn.map((cluster) => {
        const single = cluster.members.length === 1 ? cluster.members[0] : null;
        // Everything recedes rather than disappearing when somebody is
        // selected: a dispatcher looking at one technician still needs to see
        // what is near them.
        const dim = Boolean(
          highlighted && !cluster.members.some((member) => highlighted.has(member.id)),
        );

        return (
          <Fragment key={cluster.key}>
            <Marker
              anchor="bottom"
              latitude={cluster.latitude}
              longitude={cluster.longitude}
              onClick={(event) => {
                event.originalEvent.stopPropagation();
                if (single) {
                  setOpenKey(cluster.key);
                  return;
                }
                // A badge is a request to see inside it, not a thing to read.
                // Zoom until its members separate rather than opening a window
                // that can only say "several".
                const target = zoomToIsolate(cluster.members, cluster.members[0].id, zoom, 21);
                map?.easeTo({ center: [cluster.longitude, cluster.latitude], zoom: target });
              }}
              style={{ zIndex: single ? 100 : 90 }}
            >
              <span title={single ? single.name : `${cluster.members.length} properties`}>
                {single ? (
                  <PropertyPin dim={dim} />
                ) : (
                  <ClusterPin count={cluster.members.length} dim={dim} />
                )}
              </span>
            </Marker>

            {openKey === cluster.key ? (
              <Popup
                anchor="bottom"
                closeOnClick={false}
                latitude={cluster.latitude}
                longitude={cluster.longitude}
                offset={34}
                onClose={() => setOpenKey(null)}
              >
                {single ? (
                  <>
                    <span className="font-medium">{single.name}</span>
                    {/* Said on the pin as well as in the list, because a reader
                     * who arrived by clicking the map never saw the list. The
                     * address is fictional and sits in the middle of the service
                     * area, so an unmarked pin is one somebody routes to. */}
                    {single.isDemo ? (
                      <>
                        {' '}
                        <Badge variant="warning">Demo</Badge>
                      </>
                    ) : null}
                    <br />
                    {single.addressLine1}
                    {single.city ? `, ${single.city}` : null}
                    <br />
                    {/* The number the hours come from, in words, beside the
                     * circle drawing it. Saying the centre was moved matters
                     * as much as the radius: a ring sitting off the building
                     * is a correction somebody made, not a geocoder's mistake,
                     * and without this line it reads as a bug. */}
                    <span className="text-muted-foreground text-xs">
                      On site within {single.enterRadiusMeters}m
                      {single.geofenceMoved ? ' · centre set by the office' : null}
                    </span>
                  </>
                ) : (
                  <span className="font-medium">{cluster.members.length} properties here</span>
                )}
              </Popup>
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
});

/**
 * One technician on the map: where they are, and how they are moving.
 *
 * The arrow while they are driving, the person badge otherwise. Slides from fix
 * to fix instead of jumping, so a drive reads as a drive.
 *
 * Anchored at its centre: the coordinate is the middle of the badge or the
 * arrow, which is also where the accuracy ring is drawn from. Everything else
 * on this map is anchored at its bottom edge, because everything else is a pin
 * with a point.
 */
export const TechnicianMarker = memo(function TechnicianMarker({
  dim,
  motion,
  onSelect,
  position,
  selected,
}: {
  dim: boolean;
  motion: Motion | null;
  /** Absent on a map where picking a person leads nowhere: then nothing is clickable. */
  onSelect?: (technicianId: string) => void;
  position: TechnicianPosition;
  selected: boolean;
}) {
  const at = useGlide(position.latitude, position.longitude);
  const stale = Date.now() - Date.parse(position.recordedAt) > STALE_AFTER_MS;
  // A stale fix's course is the direction they were travelling whenever it was
  // taken, which may be hours ago. `motion.live` already refuses anything over
  // a few minutes; `stale` is the half-hour line the rest of the map uses.
  const driving = !stale && drawsAsDriving(motion);

  return (
    <Marker
      anchor="center"
      latitude={at.lat}
      longitude={at.lng}
      onClick={
        onSelect
          ? (event) => {
              event.originalEvent.stopPropagation();
              onSelect(position.technicianId);
            }
          : undefined
      }
      style={{ zIndex: selected ? 520 : 500 }}
    >
      <span title={position.technician?.displayName ?? 'Unknown technician'}>
        {driving && motion ? (
          <DrivingPin
            dim={dim}
            heading={motion.headingDegrees ?? 0}
            stopped={motion.state === 'STOPPED'}
          />
        ) : (
          <TechnicianPin
            dim={dim}
            heading={
              !stale && motion?.live && motion.state === 'ON_FOOT' ? motion.headingDegrees : null
            }
            stale={stale}
          />
        )}
      </span>
    </Marker>
  );
});

/** What a map says about the portfolio, beyond the properties themselves. */
export interface PortfolioOptions {
  /** Every property. Fetched, behind `properties:read`, when not given. */
  properties?: readonly PropertyPosition[];
  /**
   * The properties the page is about -- a technician's stops, a planned day.
   * Everything else recedes rather than disappearing, because what is near the
   * day is what somebody is weighing up. Null when nothing is picked.
   */
  highlighted?: ReadonlySet<string> | null;
  /** Picked from a list, so its window opens without a second click. */
  selectedPropertyId?: string | null;
}

/** What a map says about the crew, beyond where they are. */
export interface CrewOptions {
  /** Where everyone is. Fetched, behind `technicians:locate`, when not given. */
  positions?: readonly TechnicianPosition[];
  selectedTechnicianId?: string | null;
  /** Absent where picking a person leads nowhere, so nobody is clickable. */
  onSelect?: (technicianId: string) => void;
  /** The last few minutes of fixes, when the page already keeps them for other things. */
  tracks?: ReadonlyMap<string, Parameters<typeof motionOf>[0]>;
}

/**
 * Every property, exactly as the technician map draws it.
 *
 * Grouped pins that open on a click, a dot for each at its exact position, and
 * each lone property's geofence once it is big enough to read. Drawn from the
 * same positions everywhere -- `propertyPosition` on the server, which puts a
 * property at the office's corrected centre when there is one -- so no map in
 * the console can show a property somewhere another map does not.
 */
export function PortfolioLayers({
  properties,
  highlighted = null,
  selectedPropertyId = null,
}: Required<Pick<PortfolioOptions, 'properties'>> & Omit<PortfolioOptions, 'properties'>) {
  return (
    <>
      <PropertyDotsLayer points={properties} />
      <PropertyLayer
        highlighted={highlighted}
        properties={properties}
        selectedPropertyId={selectedPropertyId}
      />
    </>
  );
}

/**
 * The crew, exactly as the technician map draws them.
 *
 * The arrow while driving, the badge otherwise, the ring of claimed accuracy
 * when a fix is vague, and the same staleness line everywhere.
 */
export function CrewLayers({
  positions,
  selectedTechnicianId = null,
  onSelect,
  tracks,
}: Required<Pick<CrewOptions, 'positions'>> & Omit<CrewOptions, 'positions'>) {
  // Always called, so the hook order never changes; the page's own tracks win
  // when it keeps them, which the technician map does for its heads-up panel.
  const own = useMotionTracks(positions);
  const motion = tracks ?? own;
  const now = Date.now();

  return (
    <>
      <AccuracyLayer positions={positions} />
      {positions.map((position) => (
        // Keyed on the technician, not the fix. The fix's id is new on every
        // report, which remounted the marker each time -- so there was nothing
        // to slide, only a marker destroyed and drawn again.
        <TechnicianMarker
          dim={Boolean(selectedTechnicianId) && position.technicianId !== selectedTechnicianId}
          key={position.technicianId}
          motion={motionOf(motion.get(position.technicianId) ?? [], now)}
          onSelect={onSelect}
          position={position}
          selected={position.technicianId === selectedTechnicianId}
        />
      ))}
    </>
  );
}
