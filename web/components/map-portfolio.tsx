'use client';

import type { PropertyPosition, TechnicianPosition } from '@texasrenters/shared';
import { ONLINE_WITHIN_MS } from '@texasrenters/shared';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Layer, Marker, Popup, Source, useMap } from 'react-map-gl/mapbox';

import { InspectionDetailsLink } from '@/components/inspection-details-link';
import { inBox, padBox, ringIsLegible, spotOffsets, type Box } from '@/components/map-clusters';
import { useMapStroke } from '@/components/map-colors';
import {
  DoneBadge,
  GroupDisc,
  LooseDisc,
  OTHER_PROPERTY_RIM,
  OTHER_PROPERTY_YELLOW,
  popupOffsets,
} from '@/components/map-discs';
import { circleFeature, featureCollection } from '@/components/map-geometry';
import { ZoneLayers } from '@/components/map-zones';
import { groupColorOf, UNGROUPED_GREEN } from '@/components/planning/group-file';
import { zoneTerritories } from '@/components/planning/zone-territories';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { DrivingPin, TechnicianPin } from '@/components/map-pins';
import { businessTimeOfDay } from '@/lib/clock';
import { allSubmitted, type PropertyVisit } from '@/lib/day-visits';
import { humanize } from '@/lib/format';
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
/** What a property is on the map: in a group, on the package in none, or the rest of the portfolio. */
type DiscKind = 'GROUP' | 'LOOSE' | 'OTHER';

const kindOf = (property: PropertyPosition): DiscKind =>
  property.tbpGroup ? 'GROUP' : property.tbpEnrolled ? 'LOOSE' : 'OTHER';

/** "Group 12 · Katy North", or just the name when it already says the number. */
function groupLabel(group: NonNullable<PropertyPosition['tbpGroup']>) {
  const number = `Group ${group.position}`;
  return group.name.trim() && group.name.trim() !== number ? `${number} · ${group.name.trim()}` : number;
}

/** What hovering over a disc says, before it is clicked. */
function discTitle(property: PropertyPosition, done: boolean) {
  const said = property.tbpGroup
    ? `${property.name} · ${groupLabel(property.tbpGroup)}`
    : property.tbpEnrolled
      ? `${property.name} · benefit package, in no group`
      : property.name;
  return done ? `${said} · inspection submitted` : said;
}

/** Group discs over the green ones, the green over the yellow: work to plan is never under the rest. */
const DISC_Z: Record<DiscKind, number> = { GROUP: 100, LOOSE: 95, OTHER: 90 };

/**
 * One property, as the Group maker draws it: a disc in its group's colour, the
 * maker's green for a benefit-package property in no group, and yellow for the
 * rest of the portfolio -- with a tick on it once the day's inspection there is
 * in, where the map is about a day.
 *
 * A placed centre the office corrected is exact whatever the geocoder said; a
 * zip-code centre is drawn pale with a dashed rim, as in the Group maker.
 */
const PortfolioDisc = memo(function PortfolioDisc({
  property,
  dim,
  done,
  offset,
  open,
  onOpen,
}: {
  property: PropertyPosition;
  dim: boolean;
  /** Every inspection it had on the day being shown is in. */
  done: boolean;
  offset: [number, number] | undefined;
  open: boolean;
  onOpen: (propertyId: string) => void;
}) {
  const kind = kindOf(property);
  const approximate = !property.geofenceMoved && property.geocodePrecision === 'CENTROID';
  const ink = property.tbpGroup ? (groupColorOf(property.tbpGroup.color)?.ink ?? '#fff') : '#fff';
  return (
    <Marker
      anchor="center"
      latitude={property.latitude}
      longitude={property.longitude}
      offset={offset}
      onClick={(event) => {
        event.originalEvent.stopPropagation();
        onOpen(property.id);
      }}
      style={{ zIndex: open ? 110 : DISC_Z[kind] }}
    >
      {/* Everything recedes rather than disappearing when somebody is
          selected: a dispatcher looking at one technician still needs to see
          what is near them. */}
      <span
        className="relative inline-flex"
        style={dim ? { opacity: 0.25 } : undefined}
        title={discTitle(property, done)}
      >
        {property.tbpGroup ? (
          <GroupDisc approximate={approximate} fill={property.tbpGroup.color} ink={ink} />
        ) : kind === 'LOOSE' ? (
          <LooseDisc approximate={approximate} color={UNGROUPED_GREEN} />
        ) : (
          <LooseDisc approximate={approximate} color={OTHER_PROPERTY_YELLOW} rim={OTHER_PROPERTY_RIM} />
        )}
        {/* On the disc's shoulder rather than in place of it: the colour still
            says which group, the tick says the day's work there is in. */}
        {done ? <DoneBadge className="absolute -top-1.5 -right-1.5" /> : null}
      </span>
    </Marker>
  );
});

/**
 * The day's inspections at a property, in its window, each with the way to its
 * details (the office, 2026-10-02: "on the dialogue add a button where it says
 * show inspection details").
 */
function DayVisits({ visits }: { visits: readonly PropertyVisit[] }) {
  return (
    <ul className="grid gap-2 border-t pt-2">
      {visits.map((visit) => {
        const at = visit.finished ? businessTimeOfDay(visit.finishedAt) : null;
        return (
          <li className="grid gap-1" key={visit.inspectionId}>
            <p className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium">{humanize(visit.inspectionType)}</span>
              <StatusBadge value={visit.status} />
            </p>
            <p className="text-muted-foreground text-xs">
              {visit.technicianName}
              {at ? ` · done ${at}` : null}
            </p>
            <InspectionDetailsLink inspectionId={visit.inspectionId} />
          </li>
        );
      })}
    </ul>
  );
}

/** What a disc's window says. */
function PropertyDetails({
  property,
  visits,
}: {
  property: PropertyPosition;
  visits: readonly PropertyVisit[] | undefined;
}) {
  return (
    <div className="grid max-w-64 gap-1 text-sm">
      <p>
        <span className="font-medium">{property.name}</span>
        {/* Said on the pin as well as in the list, because a reader who
         * arrived by clicking the map never saw the list. The address is
         * fictional and sits in the middle of the service area, so an
         * unmarked pin is one somebody routes to. */}
        {property.isDemo ? (
          <>
            {' '}
            <Badge variant="warning">Demo</Badge>
          </>
        ) : null}
        <br />
        {property.addressLine1}
        {property.city ? `, ${property.city}` : null}
      </p>
      {property.tbpGroup ? (
        <p className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-3 shrink-0 rounded-full border border-white"
            style={{ backgroundColor: property.tbpGroup.color }}
          />
          {groupLabel(property.tbpGroup)}
        </p>
      ) : property.tbpEnrolled ? (
        <p>Benefit package, in no group</p>
      ) : property.tbpEnrolled === false ? (
        <p className="text-muted-foreground">Not on the benefit package</p>
      ) : null}
      {property.zone ? <p className="text-xs">Zone {property.zone}</p> : null}
      {/* The number the hours come from, in words, beside the circle drawing
       * it. Saying the centre was moved matters as much as the radius: a ring
       * sitting off the building is a correction somebody made, not a
       * geocoder's mistake, and without this line it reads as a bug. */}
      <p className="text-muted-foreground text-xs">
        On site within {property.enterRadiusMeters}m
        {property.geofenceMoved ? ' · centre set by the office' : null}
      </p>
      {visits?.length ? <DayVisits visits={visits} /> : null}
    </div>
  );
}

/**
 * Every property, each its own disc (the office, 2026-10-01).
 *
 * This grouped pins into count badges as they came near each other. The office
 * found the Group maker's map the better one -- every property a disc in its
 * group's colour, at every zoom, no badges -- and asked for it on every map,
 * with every active property and not only the benefit-package ones the Group
 * maker shows.
 *
 * Only the discs on or near the screen are drawn: every property all the time
 * is hundreds of real elements the map moves on every frame of a zoom, and
 * zooming once froze for up to a second that way. The open window's disc stays
 * drawn when panned away, so its window does not close under the reader.
 * Keyed by property, so a zoom never throws a disc away to draw it again.
 *
 * Memoised, and that is the single biggest thing on the technician map:
 * positions arrive over the socket every few seconds, re-rendering the page and
 * everything under it, and none of this layer's props move when a technician
 * does.
 */
export const PropertyLayer = memo(function PropertyLayer({
  highlighted,
  properties,
  selectedPropertyId,
  visits = null,
}: {
  /** The day's inspections by property, where the map is about a day. See `PortfolioOptions.visits`. */
  visits?: ReadonlyMap<string, readonly PropertyVisit[]> | null;
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
  const { zoom, box } = useSettledView();
  const [openId, setOpenId] = useState<string | null>(selectedPropertyId);
  /** The selection this layer last acted on, so churn is not mistaken for a change. */
  const lastSelected = useRef<string | null>(selectedPropertyId);

  // Two buildings at one spot are two discs side by side, not one over the other.
  const offsets = useMemo(() => spotOffsets(properties, (property) => property.id), [properties]);

  const drawn = useMemo(() => {
    if (!box) return properties;
    const reach = padBox(box, DRAWN_BEYOND_VIEW);
    return properties.filter((property) => property.id === openId || inBox(property, reach));
  }, [box, openId, properties]);

  /** The rings worth drawing: only once a property's ring is big enough on screen to be a size rather than a smudge. */
  const rings = useMemo<GeofenceRing[]>(
    () =>
      drawn.flatMap((property) =>
        ringIsLegible(property.enterRadiusMeters, property.latitude, zoom)
          ? [
              {
                id: property.id,
                latitude: property.latitude,
                longitude: property.longitude,
                enterRadiusMeters: property.enterRadiusMeters,
                exitRadiusMeters: property.exitRadiusMeters,
                dim: Boolean(highlighted && !highlighted.has(property.id)),
              },
            ]
          : [],
      ),
    [drawn, highlighted, zoom],
  );

  /**
   * A property picked from the list opens its window; letting go of it closes
   * it. **A window opened by clicking is not this effect's to close**: it runs
   * on the selection alone, so the refetch that rebuilds the property list
   * every few minutes leaves an open window alone.
   */
  useEffect(() => {
    if (selectedPropertyId === lastSelected.current) return;
    lastSelected.current = selectedPropertyId;
    setOpenId(selectedPropertyId);
  }, [selectedPropertyId]);

  const open = openId ? (properties.find((property) => property.id === openId) ?? null) : null;

  return (
    <>
      <GeofenceLayer rings={rings} />

      {drawn.map((property) => (
        <PortfolioDisc
          dim={Boolean(highlighted && !highlighted.has(property.id))}
          done={allSubmitted(visits?.get(property.id))}
          key={property.id}
          offset={offsets.get(property.id)}
          onOpen={setOpenId}
          open={property.id === openId}
          property={property}
        />
      ))}

      {open ? (
        <Popup
          // No fixed side: Mapbox opens it wherever there is room, so a disc
          // near the top of the map does not have its window cut off.
          closeOnClick={false}
          latitude={open.latitude}
          longitude={open.longitude}
          offset={popupOffsets(offsets.get(open.id) ?? [0, 0])}
          onClose={() => setOpenId(null)}
          style={{ zIndex: 900 }}
        >
          <PropertyDetails property={open} visits={visits?.get(open.id)} />
        </Popup>
      ) : null}
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
  color = null,
  dim,
  motion,
  onSelect,
  position,
  selected,
}: {
  /** Their colour on the map, ringed round the marker. Null where a map gives people none. */
  color?: string | null;
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
            ring={color}
            stopped={motion.state === 'STOPPED'}
          />
        ) : (
          <TechnicianPin
            dim={dim}
            heading={
              !stale && motion?.live && motion.state === 'ON_FOOT' ? motion.headingDegrees : null
            }
            ring={color}
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
  /**
   * The inspections each property has on the day the page is about, by
   * property. A property whose every one is in gets a tick on its disc, and
   * its window lists them with the way to each one's details. Absent on a map
   * that is not about one day.
   */
  visits?: ReadonlyMap<string, readonly PropertyVisit[]> | null;
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
  /** Each person's colour, where the page draws their lines in it -- ringed round their marker to match. */
  colors?: ReadonlyMap<string, string> | null;
}

/**
 * Every property, as every map in the console draws it.
 *
 * A disc each, in its group's colour as in the Group maker, that opens on a
 * click, with each property's geofence once it is big enough to read and each
 * zone's ground when asked for. Drawn from the
 * same positions everywhere -- `propertyPosition` on the server, which puts a
 * property at the office's corrected centre when there is one -- so no map in
 * the console can show a property somewhere another map does not.
 */
export function PortfolioLayers({
  properties,
  highlighted = null,
  selectedPropertyId = null,
  visits = null,
  zones = false,
  otherProperties = true,
}: Required<Pick<PortfolioOptions, 'properties'>> &
  Omit<PortfolioOptions, 'properties'> & {
    /** Each zone's ground and fence, as the Group maker draws them. */
    zones?: boolean;
    /** The properties off the benefit package, yellow. Off, only the package's are drawn. */
    otherProperties?: boolean;
  }) {
  /**
   * Off the package means said to be off it. A property the reader may not be
   * told about (`tbpEnrolled` absent) stays, as does one the page is about.
   */
  const shown = useMemo(
    () =>
      otherProperties
        ? properties
        : properties.filter(
            (property) =>
              property.tbpEnrolled !== false || property.id === selectedPropertyId || Boolean(highlighted?.has(property.id)),
          ),
    [highlighted, otherProperties, properties, selectedPropertyId],
  );
  // Worked out only while they are shown: a grid over the whole portfolio is not free.
  const territories = useMemo(
    () =>
      zones
        ? zoneTerritories(properties.map((property) => ({ latitude: property.latitude, longitude: property.longitude, zone: property.zone ?? null })))
        : [],
    [properties, zones],
  );

  return (
    <>
      {/* Under the properties: a zone is the ground they stand on. */}
      <ZoneLayers visible={zones} zones={territories} />
      {/* No dot per property beside the discs (the office, 2026-09-30: "there's
          a lot of small circles color blue on the map remove that for now").
          `PropertyDotsLayer` still exists -- drawing it here again is the whole
          of bringing it back. */}
      <PropertyLayer
        highlighted={highlighted}
        properties={shown}
        selectedPropertyId={selectedPropertyId}
        visits={visits}
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
  colors = null,
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
          color={colors?.get(position.technicianId) ?? null}
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
