'use client';

import type {
  PropertyPosition,
  TechnicianPosition,
  TechnicianRoute,
} from '@texasrenters/shared';
import { ONLINE_WITHIN_MS } from '@texasrenters/shared';
import {
  AdvancedMarker,
  APIProvider,
  APILoadingStatus,
  ColorScheme,
  ControlPosition,
  InfoWindow,
  Map as GoogleMap,
  MapControl,
  useApiLoadingStatus,
  useMap,
} from '@vis.gl/react-google-maps';
import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';

import { CameraDirector, type CameraFocus } from '@/components/map-camera';
import { pointsToFit } from '@/components/map-bounds';
import { RecenterControl, TechnicianHud } from '@/components/technician-hud';
import { greatCirclePath, pathMidpoint } from '@/lib/great-circle';
import { clusterByGrid, inBox, padBox, zoomToIsolate, type Box } from '@/components/map-clusters';
import { formatDistance, formatDuration } from '@/lib/format';
import { useContinuousRotation, useGlide } from '@/lib/map-animation';
import { drawsAsDriving, motionOf, type Motion } from '@/lib/technician-motion';
import { useMotionTracks } from '@/lib/use-motion-tracks';
import { MapSettings, useMapPreferences } from '@/components/map-settings';

/**
 * Where every technician was when their handset last reported, over the
 * properties they are working.
 *
 * Google Maps, replacing Leaflet and OpenStreetMap. The previous note here
 * promised that moving to another provider would be "configuration rather than
 * a rewrite", on the strength of a single tile URL — and that is true of any
 * XYZ tile source, which Google is not. Their terms require the Maps JavaScript
 * API, so the markers, popups, lines and circles are all theirs now. What did
 * survive is the part that was never about the provider: `map-bounds.ts` and
 * `map-clusters.ts` are pure arithmetic and came across untouched.
 *
 * Must be loaded with `ssr: false`. The Maps script touches `window` and
 * measures its container, neither of which exists on a server.
 */

/**
 * The browser key.
 *
 * Public by nature — it ships inside the JavaScript bundle and anyone reading
 * the page can see it, which is true of every Maps browser key and is why
 * Google's answer is **HTTP referrer restrictions**, not secrecy. Restrict it
 * to this console's hosts in the Cloud console; an unrestricted key is one
 * anybody can spend.
 *
 * Inlined at build time like every NEXT_PUBLIC_* value, so it is a property of
 * the image rather than something a restart can change.
 */
const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

/**
 * The styled map this console draws on.
 *
 * Required, not decorative: `AdvancedMarker` is only available to a map that
 * has one, and without it Google silently falls back to the legacy marker and
 * the pins below stop rendering as React at all. Created in the Cloud console
 * under Map Management.
 */
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? 'DEMO_MAP_ID';

/** Past this, a position is history rather than an answer to "where are they". */
/**
 * Kept as a re-export so this file reads the same as it did, but the number
 * now lives in `shared` -- the roster list asks the same question, and two
 * thresholds would let the list say online while the pin said otherwise.
 */
const STALE_AFTER_MS = ONLINE_WITHIN_MS;

/**
 * The view the map opens with, before any data has arrived.
 *
 * Google needs a defaultCenter and defaultZoom or it renders nothing at all.
 * The Leaflet version needed this too, for a sharper reason — a map with no
 * view could not project, and every layer added to it died on
 * `undefined.subtract`. Google fails more quietly, which is arguably worse.
 */
const FALLBACK_CENTER = { lat: 31.0, lng: -99.0 };
const FALLBACK_ZOOM = 5;

/**
 * One Earth, and only one.
 *
 * Latitude stops at ±85 rather than ±90 because Web Mercator cannot project the
 * poles — they sit at infinity. `strictBounds` is off so the edge is firm
 * without being unpannable near it.
 */
const WORLD_BOUNDS = {
  north: 85,
  south: -85,
  west: -180,
  east: 180,
};

/**
 * Markers drawn as inline SVG, now as real React rather than HTML strings.
 *
 * Leaflet needed `divIcon` and a template string because its markers are DOM it
 * builds itself. An `AdvancedMarker` takes children, so these are components —
 * the same vectors, type-checked, and the class names the stylesheet already
 * targets still apply.
 *
 * The two are separated by **shape as well as colour**: a property is the
 * classic teardrop pin planted at a spot, a technician is a round badge with a
 * person in it. Anyone who cannot reliably tell green from red still reads the
 * map correctly, which colour alone would not give them.
 *
 * White outlines on both. These sit on cartography full of green parks, blue
 * water and red arterial roads, and an unoutlined marker disappears into
 * whatever it happens to land on.
 */
function MarkerShadow() {
  return (
    <defs>
      <filter height="180%" id="pin-shadow" width="180%" x="-40%" y="-40%">
        <feDropShadow dx="0" dy="1" floodOpacity="0.35" stdDeviation="1" />
      </filter>
    </defs>
  );
}

/** A teardrop pin with a house in it, anchored at its point. */
const PropertyPin = memo(function PropertyPin({ dim = false }: { dim?: boolean }) {
  return (
    <svg height="32" opacity={dim ? 0.25 : 1} viewBox="0 0 24 32" width="24">
      <MarkerShadow />
      <path
        className="fill-map-property"
        d="M12 1.5c-5.5 0-10 4.4-10 9.9 0 7.4 10 19.1 10 19.1s10-11.7 10-19.1c0-5.5-4.5-9.9-10-9.9z"
        filter="url(#pin-shadow)"
        stroke="#fff"
        strokeWidth="2"
      />
      <path d="M12 6.6 6.6 11v6.1h3.6v-3.5h3.6v3.5h3.6V11z" fill="#fff" />
    </svg>
  );
});

/**
 * A round badge with a person in it, anchored at its centre.
 *
 * Centred rather than pointed, because unlike a property this is a reading of
 * where somebody was, not a marked spot — and the accuracy circle it sits
 * inside is drawn from the same centre.
 *
 * The canvas is 44px while the badge is still 22px across: the extra room is
 * for the pulse, which expands past the badge and would otherwise be clipped.
 *
 * No icon cache any more. Leaflet replaced a marker's whole DOM whenever the
 * `icon` prop was a new object, so a freshly built icon on every render
 * restarted the pulse from zero and read as a stutter; three cached instances
 * were the fix. React reconciles this instead — the `<circle>` survives a
 * re-render, and so does its animation.
 */
const TechnicianPin = memo(function TechnicianPin({
  stale,
  dim = false,
  heading = null,
}: {
  stale: boolean;
  dim?: boolean;
  /**
   * Course over ground, or null to draw no arrow at all.
   *
   * Null is the common case and it matters that it stays empty: a technician
   * standing in a kitchen has no course, and an arrow left over from the drive
   * in would keep asserting a direction they stopped travelling ten minutes
   * ago. The caller decides, from `motionOf`, rather than this component
   * guessing from a speed it was not given. A technician on the road gets
   * `DrivingPin` instead; this tick is for somebody moving on foot.
   */
  heading?: number | null;
}) {
  const fill = stale ? 'fill-map-technician-stale' : 'fill-map-technician';
  /**
   * Whether this person is reporting now -- and nothing else.
   *
   * This used to be `!stale && !dim`, which conflated two unrelated facts.
   * `stale` is about the technician: they have not reported for half an hour.
   * `dim` is about the *reader*: somebody else is selected. Suppressing the
   * pulse for the second reason made selecting one technician appear to take
   * everybody else offline -- reported as a bug, and it was one: the map was
   * answering "is this person out there" with "did you click on them".
   *
   * De-emphasis is the `opacity` below, which fades the pulse along with the
   * rest of the marker. That is what dimming should do: make something quieter
   * without changing what it says.
   */
  const live = !stale;

  return (
    /* 0.45 rather than 0.3. At 0.3 an online marker's colour was too faint to
       separate from the stale one, so the dimming was itself reading as
       offline -- the same bug by a different route. */
    <svg height="44" opacity={dim ? 0.45 : 1} viewBox="0 0 44 44" width="44">
      <MarkerShadow />
      {live ? (
        <circle className="map-technician-pulse fill-map-technician" cx="22" cy="22" r="11" />
      ) : null}
      {/* Rotated about the marker's own centre, which is also the coordinate
          the marker is anchored at -- so the arrow swings around the person
          rather than orbiting some other point.

          Screen-up is north because the map is never rotated: tilt changes the
          camera's pitch, not its bearing, so 0 degrees keeps pointing at the
          top of the window even in the 3D view. If a rotation control is ever
          added this must subtract the map's heading. */}
      {heading === null ? null : (
        <g transform={`rotate(${heading} 22 22)`}>
          <path
            className={fill}
            d="M22 1.5 L26.6 10.5 L22 8.4 L17.4 10.5 Z"
            stroke="#fff"
            strokeLinejoin="round"
            strokeWidth="1.5"
          />
        </g>
      )}
      <g transform="translate(8,8)">
        <circle
          className={fill}
          cx="14"
          cy="14"
          filter="url(#pin-shadow)"
          r="11"
          stroke="#fff"
          strokeWidth="2.5"
        />
        <circle cx="14" cy="11.1" fill="#fff" r="2.9" />
        <path d="M8.1 20.4c0-3.2 2.7-5.2 5.9-5.2s5.9 2 5.9 5.2z" fill="#fff" />
      </g>
    </svg>
  );
});

/**
 * A technician on the road: an arrow pointing the way they are driving.
 *
 * The navigation-app arrow rather than the person badge, because on a drive the
 * question is which way, and a badge with a small tick on its rim answered it
 * at a size nobody could read from across a desk. A white disc behind it keeps
 * it legible on a dark basemap, a satellite image, and a green park alike.
 *
 * Turned with a CSS transition, the short way round, so a heading that moves
 * from 350° to 10° is a slight right, not a spin. The pulse goes when they are
 * stopped mid-drive: still on the road, but not going anywhere this second.
 */
const DrivingPin = memo(function DrivingPin({
  dim = false,
  heading,
  stopped = false,
}: {
  dim?: boolean;
  heading: number;
  stopped?: boolean;
}) {
  const rotation = useContinuousRotation(heading);
  return (
    <svg height="44" opacity={dim ? 0.45 : 1} viewBox="0 0 44 44" width="44">
      <MarkerShadow />
      {stopped ? null : (
        <circle className="map-technician-pulse fill-map-technician" cx="22" cy="22" r="13" />
      )}
      <circle cx="22" cy="22" fill="#fff" filter="url(#pin-shadow)" r="14.5" />
      <path
        className="fill-map-technician"
        d="M22 9.5 L30 31.5 L22 26.8 L14 31.5 Z"
        stroke="#fff"
        strokeLinejoin="round"
        strokeWidth="1"
        style={{
          transform: `rotate(${rotation}deg)`,
          transformOrigin: '22px 22px',
          transition: 'transform 700ms ease-out',
        }}
      />
    </svg>
  );
});

/**
 * A badge standing in for several properties too close to draw separately.
 *
 * Sized by how many it hides, in three coarse steps rather than continuously:
 * the useful signal is "a few" versus "a lot", and a smoothly growing circle
 * just makes every cluster look slightly different from every other one.
 */
const ClusterPin = memo(function ClusterPin({ count, dim = false }: { count: number; dim?: boolean }) {
  const size = count < 10 ? 30 : count < 50 ? 36 : 42;
  return (
    <svg
      height={size}
      opacity={dim ? 0.25 : 1}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
    >
      <circle
        className="fill-map-property"
        cx={size / 2}
        cy={size / 2}
        opacity="0.35"
        r={size / 2 - 3}
      />
      <circle
        className="fill-map-property"
        cx={size / 2}
        cy={size / 2}
        r={size / 2 - 6}
        stroke="#fff"
        strokeWidth="2"
      />
      <text
        dominantBaseline="central"
        fill="#fff"
        fontFamily="system-ui, sans-serif"
        fontSize={count < 100 ? 12 : 10}
        fontWeight="600"
        textAnchor="middle"
        x="50%"
        y="50%"
      >
        {count}
      </text>
    </svg>
  );
});

/**
 * A numbered stop on the recommended route.
 *
 * Green for the next stop -- where the technician is heading -- and the route's
 * orange for the rest.
 */
const StopPin = memo(function StopPin({ order, next = false }: { order: number; next?: boolean }) {
  return (
    <svg height="24" viewBox="0 0 24 24" width="24">
      <circle
        className={next ? 'fill-map-route-next' : 'fill-map-route'}
        cx="12"
        cy="12"
        r="10"
        stroke="#fff"
        strokeWidth="2"
      />
      <text
        dominantBaseline="central"
        fill="#fff"
        fontFamily="system-ui, sans-serif"
        fontSize="11"
        fontWeight="700"
        textAnchor="middle"
        x="50%"
        y="50%"
      >
        {order}
      </text>
    </svg>
  );
});

/** A stop already finished: grey and ticked, out of the way of what is left. */
const DonePin = memo(function DonePin() {
  return (
    <svg height="20" viewBox="0 0 24 24" width="20">
      <circle className="fill-map-route-done" cx="12" cy="12" r="10" stroke="#fff" strokeWidth="2" />
      <path
        d="M7.5 12.5l3 3 6-6.5"
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
    </svg>
  );
});

/** A plane, marking a journey nobody is driving. */
const PlanePin = memo(function PlanePin() {
  return (
    <svg height="26" viewBox="0 0 24 24" width="26">
      <circle className="fill-map-air" cx="12" cy="12" r="11" stroke="#fff" strokeWidth="2" />
      <path
        d="M12 4.6c.5 0 .9.4.9.9v3.2l4.7 2.8v1.3l-4.7-1.4v3.3l1.6 1.2v1L12 17.4l-2.5.5v-1l1.6-1.2v-3.3l-4.7 1.4v-1.3l4.7-2.8V5.5c0-.5.4-.9.9-.9z"
        fill="#fff"
      />
    </svg>
  );
});

/**
 * The zoom and the visible area, as state, as of the last time the map settled.
 *
 * Grouping is worked out in projected pixels at the current zoom, so it changes
 * when the zoom does and never when panning — a clustering that reshuffled as
 * you dragged would read as the data itself moving. The visible area decides
 * which of those groups are drawn at all.
 */
function useSettledView() {
  const map = useMap();
  const [view, setView] = useState<{ zoom: number; box: Box | null }>({
    zoom: FALLBACK_ZOOM,
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
              north: bounds.getNorthEast().lat(),
              south: bounds.getSouthWest().lat(),
              east: bounds.getNorthEast().lng(),
              west: bounds.getSouthWest().lng(),
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
     * `idle`, not `zoom_changed` or `bounds_changed`.
     *
     * Those fire on every frame of a scroll, pinch or drag, and each one
     * re-grouped the properties and reconciled every marker — mid-gesture,
     * several times a second. `idle` fires once, when the map settles, so the
     * work happens exactly as often as the answer actually changes.
     */
    const listener = map.addListener('idle', sync);
    return () => listener.remove();
  }, [map]);

  return view;
}

/**
 * How far past the edge of the map markers are still drawn, as a share of the
 * view's size on each side -- so a short pan does not uncover an empty strip
 * that fills in only when the map settles.
 */
const DRAWN_BEYOND_VIEW = 0.5;

/**
 * A `google.maps.Polyline`, as a component.
 *
 * There is no React wrapper for these in the library, and the imperative
 * lifecycle is the whole reason this exists: a polyline added on every render
 * without being removed leaves the old one on the map, and a route redrawn
 * every few seconds turns into a thicket.
 */
/**
 * Which computed property actually carries the line's colour.
 *
 * `stroke` first. The map's line classes set `stroke`, because under Leaflet
 * the class landed on an SVG path, where that is the property that paints.
 * After the port to Google this read `color` instead — which on a bare `span`
 * inherits the body's text colour — so every line was drawn in near-black, the
 * white casing included, and changing the design token moved nothing at all.
 *
 * `color` is kept as a fallback for any class that legitimately sets it, and
 * the literal behind that is for a class that sets neither.
 */
export function strokeFrom(computed: {
  stroke?: string | null;
  color?: string | null;
}): string {
  // `stroke` computes to "none" on an element no rule has touched. That is not
  // a colour and must not reach Google as one -- it draws an invisible line,
  // which looks exactly like a route that failed to load.
  const painted =
    computed.stroke && computed.stroke !== 'none' ? computed.stroke : '';
  return painted || computed.color || '#2563eb';
}

function Line({
  path,
  className,
  weight,
  opacity,
  dashed = false,
  zIndex,
}: {
  path: readonly [number, number][];
  className: string;
  weight: number;
  opacity: number;
  dashed?: boolean;
  zIndex: number;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map || !path.length) return;
    /**
     * The colour comes from the stylesheet, read off a probe element.
     *
     * Google styles its overlays through options rather than CSS classes, so
     * the design-system tokens these lines are drawn in — `map-route-line`,
     * `map-air-line` — cannot simply be handed over as a class name. Reading
     * the computed value keeps one source of truth: change the token and the
     * line follows, exactly as it did under Leaflet.
     *
     * **`stroke`, not `color`.** Those classes set `stroke`, because under
     * Leaflet the class landed on an SVG path where that is the property that
     * paints. This read `color` after the port, which on a bare span inherits
     * the body's text colour — so every line was drawn in near-black, the
     * casing included, and changing the token moved nothing. `color` stays as
     * a fallback for any class that does set it.
     */
    const probe = document.createElement('span');
    probe.className = className;
    probe.style.display = 'none';
    document.body.append(probe);
    const stroke = strokeFrom(getComputedStyle(probe));
    probe.remove();

    const line = new google.maps.Polyline({
      map,
      path: path.map(([lat, lng]) => ({ lat, lng })),
      strokeColor: stroke,
      strokeOpacity: dashed ? 0 : opacity,
      strokeWeight: weight,
      zIndex,
      ...(dashed
        ? {
            icons: [
              {
                icon: {
                  path: 'M 0,-1 0,1',
                  strokeOpacity: opacity,
                  strokeWeight: weight,
                  scale: 3,
                },
                offset: '0',
                repeat: '14px',
              },
            ],
          }
        : {}),
    });

    return () => line.setMap(null);
  }, [map, path, className, weight, opacity, dashed, zIndex]);

  return null;
}

/**
 * The claimed accuracy, drawn to scale.
 *
 * A 5m fix and a 300m fix are very different statements, and a map that drew
 * them as the same dot would be asserting something nobody knows.
 */
function AccuracyRing({
  latitude,
  longitude,
  radiusMeters,
}: {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    const circle = new google.maps.Circle({
      map,
      center: { lat: latitude, lng: longitude },
      radius: radiusMeters,
      strokeOpacity: 0.45,
      strokeWeight: 1,
      fillOpacity: 0.1,
      clickable: false,
      zIndex: 1,
    });
    return () => circle.setMap(null);
  }, [map, latitude, longitude, radiusMeters]);

  return null;
}

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
 */
const PropertyLayer = memo(function PropertyLayer({
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
  const map = useMap();
  const { zoom, box } = useSettledView();
  const [openKey, setOpenKey] = useState<string | null>(null);

  const clusters = useMemo(() => clusterByGrid(properties, zoom), [properties, zoom]);

  /**
   * Only the groups on or near the screen are drawn.
   *
   * Every property used to be a marker all the time. At street level that is
   * every one of them standing alone -- 586 in production -- nearly all of them
   * miles off-screen, each a real element Google repositions on every frame of
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
    if (!selectedPropertyId) {
      setOpenKey(null);
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
      {drawn.map((cluster) => {
        const single = cluster.members.length === 1 ? cluster.members[0] : null;
        // Everything recedes rather than disappearing when somebody is
        // selected: a dispatcher looking at one technician still needs to see
        // what is near them.
        const dim = Boolean(
          highlighted && !cluster.members.some((member) => highlighted.has(member.id)),
        );
        const position = { lat: cluster.latitude, lng: cluster.longitude };

        return (
          <Fragment key={cluster.key}>
            <AdvancedMarker
              onClick={() => {
                if (single) {
                  setOpenKey(cluster.key);
                  return;
                }
                // A badge is a request to see inside it, not a thing to read.
                // Zoom until its members separate rather than opening a window
                // that can only say "several".
                const target = zoomToIsolate(cluster.members, cluster.members[0].id, zoom, 21);
                map?.panTo(position);
                map?.setZoom(target);
              }}
              position={position}
              title={single ? single.name : `${cluster.members.length} properties`}
              zIndex={single ? 100 : 90}
            >
              {single ? <PropertyPin dim={dim} /> : <ClusterPin count={cluster.members.length} dim={dim} />}
            </AdvancedMarker>

            {openKey === cluster.key ? (
              <InfoWindow onCloseClick={() => setOpenKey(null)} position={position}>
                {single ? (
                  <>
                    <span className="font-medium">{single.name}</span>
                    <br />
                    {single.addressLine1}
                    {single.city ? `, ${single.city}` : null}
                  </>
                ) : (
                  <span className="font-medium">{cluster.members.length} properties here</span>
                )}
              </InfoWindow>
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
});

/**
 * Memoised, and that is the single biggest thing on this map.
 *
 * Technician positions arrive over the socket every few seconds, re-rendering
 * this page and everything under it. Without this, each of those frames
 * reconciled ~40 cluster markers whose props had not changed — every one an
 * `AdvancedMarker`, which is a real DOM element Google repositions itself.
 *
 * None of this layer's props move when a technician does.
 */

/**
 * The recommended drive, under the markers.
 *
 * Two lines, not one: a wide casing under a narrow line is what keeps a route
 * legible over both pale suburb and dark motorway.
 */
const RouteLayer = memo(function RouteLayer({
  currentInspectionIds,
  route,
}: {
  /** The visit under way, from the location trail, so its stop can say so. */
  currentInspectionIds: readonly string[] | null;
  route: TechnicianRoute | null;
}) {
  const [openStop, setOpenStop] = useState<string | null>(null);

  if (!route) return null;

  const current = new Set(currentInspectionIds ?? []);
  // The first stop still ahead: not the one they are standing at.
  const nextId = route.geometry.length
    ? route.stops.find((stop) => !current.has(stop.inspectionId))?.inspectionId
    : undefined;

  return (
    <>
      {/* The day so far, in grey and under the orange: the drive through the
          stops already finished, and a tick on each. They used to disappear
          from the map as they were submitted, so an afternoon showed only what
          was left. */}
      {route.history.geometry.length ? (
        <>
          <Line
            className="map-route-casing"
            opacity={0.6}
            path={route.history.geometry}
            weight={7}
            zIndex={0}
          />
          <Line
            className="map-route-done-line"
            opacity={0.95}
            path={route.history.geometry}
            weight={4}
            zIndex={1}
          />
        </>
      ) : null}
      {route.history.stops.map((stop) => {
        const position = { lat: stop.latitude, lng: stop.longitude };
        return (
          <Fragment key={`done-${stop.inspectionId}`}>
            <AdvancedMarker
              onClick={() => setOpenStop(stop.inspectionId)}
              position={position}
              zIndex={700}
            >
              <DonePin />
            </AdvancedMarker>
            {openStop === stop.inspectionId ? (
              <InfoWindow onCloseClick={() => setOpenStop(null)} position={position}>
                <div className="text-popover-foreground text-xs leading-relaxed">
                  <div className="text-sm font-medium">{stop.propertyName}</div>
                  <div className="text-muted-foreground">
                    {stop.addressLine1}
                    {stop.city ? `, ${stop.city}` : null}
                  </div>
                  <div className="mt-1">Done</div>
                </div>
              </InfoWindow>
            ) : null}
          </Fragment>
        );
      })}

      {route.geometry.length ? (
        <>
          <Line
            className="map-route-casing"
            opacity={0.9}
            path={route.geometry}
            weight={9}
            zIndex={2}
          />
          <Line className="map-route-line" opacity={1} path={route.geometry} weight={4} zIndex={3} />
        </>
      ) : null}
      {(route.geometry.length ? route.stops : []).map((stop, index) => {
        const position = { lat: stop.latitude, lng: stop.longitude };
        // Legs run parallel to stops -- leg[i] is the drive that *arrives* at
        // stop[i], so the first one starts from the technician rather than
        // from another stop. That is also why `fromStopId` is nullable.
        const leg = route.legs[index];
        // Driving only. It deliberately excludes time spent inside the
        // properties before this one, because nothing here knows that yet --
        // so it is labelled as driving rather than presented as an arrival
        // time, which would be wrong by however long the day's work takes.
        const drivingSoFar = route.legs
          .slice(0, index + 1)
          .reduce((total, each) => total + each.durationSeconds, 0);
        return (
          <Fragment key={stop.inspectionId}>
            {/* Above the property pin it sits on, and above the technician,
                because while a route is shown the order is the thing being
                read. */}
            <AdvancedMarker
              onClick={() => setOpenStop(stop.inspectionId)}
              position={position}
              zIndex={800}
            >
              {current.has(stop.inspectionId) ? (
                // Where the technician is, labelled on the pin itself beside
                // the marker that moves, so "which property" has an answer on
                // the map as well as in the list.
                <div className="flex flex-col items-center gap-0.5">
                  <span className="bg-map-technician rounded-full px-1.5 py-px text-[10px] font-semibold whitespace-nowrap text-white shadow">
                    Here now
                  </span>
                  <StopPin order={index + 1} />
                </div>
              ) : (
                <StopPin next={stop.inspectionId === nextId} order={index + 1} />
              )}
            </AdvancedMarker>
            {openStop === stop.inspectionId ? (
              <InfoWindow onCloseClick={() => setOpenStop(null)} position={position}>
                {/* Explicit colours for the same reason as the technician
                    bubble: the theme fix in `globals.css` hangs off one of
                    Google's undocumented class names, and this does not. */}
                <div className="text-popover-foreground text-xs leading-relaxed">
                  <div className="text-sm font-medium">
                    {index + 1}. {stop.propertyName}
                  </div>
                  <div className="text-muted-foreground">
                    {stop.addressLine1}
                    {stop.city ? `, ${stop.city}` : null}
                  </div>
                  {leg ? (
                    <div className="mt-1">
                      <div>
                        {formatDuration(leg.durationSeconds)} · {formatDistance(leg.distanceMeters)}{' '}
                        <span className="text-muted-foreground">
                          {leg.fromStopId === null ? 'from the technician' : 'from the last stop'}
                        </span>
                      </div>
                      {/* Only once there is something to accumulate. On the
                          first stop the running total and the leg are the same
                          number, and printing it twice reads as an error. */}
                      {index > 0 ? (
                        <div className="text-muted-foreground">
                          {formatDuration(drivingSoFar)} driving so far
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </InfoWindow>
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
});

/**
 * The journey when there is no drive.
 *
 * Dashed and in its own colour, because it is emphatically not the road line:
 * nobody drives this, and drawing it like the routed one would suggest we had
 * planned it. The plane sits on the path rather than at either end, which is
 * the only position that reads as "between these two" rather than "here".
 *
 * There is no time on it. A flight duration needs airports, schedules and
 * connections this system does not have, and deriving one from distance would
 * be wrong by hours while looking authoritative.
 */
const AirTravelLayer = memo(function AirTravelLayer({ route }: { route: TechnicianRoute | null }) {
  const runs = useMemo(() => {
    if (!route?.airTravel || !route.origin) return [];
    const stop = route.stops.find((entry) => entry.inspectionId === route.airTravel?.inspectionId);
    if (!stop) return [];
    return greatCirclePath(route.origin, stop);
  }, [route]);

  if (!runs.length) return null;
  const middle = pathMidpoint(runs);

  return (
    <>
      {runs.map((run, index) => (
        <Line
          className="map-air-line"
          dashed
          key={index}
          opacity={0.9}
          path={run}
          weight={2}
          zIndex={2}
        />
      ))}
      {middle ? (
        <AdvancedMarker position={{ lat: middle[0], lng: middle[1] }} zIndex={700}>
          <PlanePin />
        </AdvancedMarker>
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
 * arrow, which is also where the accuracy ring is drawn from. Google anchors a
 * marker at its bottom edge unless told otherwise, and did here -- every
 * technician sat half a badge above the point they reported.
 */
const TechnicianMarker = memo(function TechnicianMarker({
  dim,
  motion,
  onSelect,
  position,
  selected,
}: {
  dim: boolean;
  motion: Motion | null;
  onSelect: (technicianId: string) => void;
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
    <AdvancedMarker
      anchorLeft="-50%"
      anchorTop="-50%"
      onClick={() => onSelect(position.technicianId)}
      position={at}
      title={position.technician?.displayName ?? 'Unknown technician'}
      zIndex={selected ? 520 : 500}
    >
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
    </AdvancedMarker>
  );
});

/** Said plainly, rather than rendering a grey rectangle nobody can diagnose. */
function MapUnavailable({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card text-muted-foreground flex h-full w-full items-center justify-center rounded-lg border p-6 text-center text-sm">
      <p>{children}</p>
    </div>
  );
}

/**
 * The map, or the reason there is not one.
 *
 * **The page has to survive Google refusing us.** When the API rejects the key
 * — a referrer restriction that does not cover the host is the easy way to get
 * there — the map never initialises, and the first `AdvancedMarker` to mount
 * calls `getRootNode` on an element that was never created. That exception is
 * uncaught, so the route's error boundary replaced the whole technician map
 * page with "This page could not be displayed", roster and property list
 * included.
 *
 * A third-party auth failure is not a reason to lose everything beside the map.
 * Nothing that touches `google.maps` mounts until the API says it is ready, so
 * the failure stays the size of the map.
 */
function MapOrReason({ children }: { children: React.ReactNode }) {
  const status = useApiLoadingStatus();

  if (status === APILoadingStatus.AUTH_FAILURE)
    return (
      <MapUnavailable>
        Google rejected this key for this site.
        <br />
        Add <code className="font-mono">{globalThis.location?.origin ?? 'this origin'}/*</code> to
        the key&rsquo;s HTTP referrer restrictions in the Cloud console.
      </MapUnavailable>
    );

  if (status === APILoadingStatus.FAILED)
    return (
      <MapUnavailable>Google Maps could not be loaded. Reloading usually clears it.</MapUnavailable>
    );

  // NOT_LOADED and LOADING both render the children: the `<Map>` element has to
  // be mounted for the library to begin loading at all.
  return <>{children}</>;
}

export function TechnicianMap({
  currentInspectionIds = null,
  highlightedBuildingIds = null,
  onSelectTechnician,
  positions,
  properties = [],
  route = null,
  selectedPropertyId = null,
  selectedTechnicianId = null,
}: {
  /** The selected technician's visit under way, by their location trail. */
  currentInspectionIds?: readonly string[] | null;
  highlightedBuildingIds?: ReadonlySet<string> | null;
  /** A technician's marker was clicked: select them, which follows them. */
  onSelectTechnician?: (technicianId: string) => void;
  positions: readonly TechnicianPosition[];
  properties?: readonly PropertyPosition[];
  /** The selected technician's drive, when one has been worked out. */
  route?: TechnicianRoute | null;
  /** A property picked from the list, which the map flies to. */
  selectedPropertyId?: string | null;
  selectedTechnicianId?: string | null;
}) {
  /**
   * The map follows the console, not the operating system.
   *
   * `resolvedTheme` rather than `theme`, because `theme` can be the string
   * `system` and Google needs an answer. A light map inside a dark console was
   * the brightest thing on the screen by a wide margin — and this console is
   * read at night, from Manila, by people looking at a Texas afternoon.
   *
   * Google's own `FOLLOW_SYSTEM` is deliberately not used: it follows the
   * operating system, which is a different question from what the reader chose
   * in the theme switcher two inches away.
   */
  const { resolvedTheme } = useTheme();
  const colorScheme = resolvedTheme === 'dark' ? ColorScheme.DARK : ColorScheme.LIGHT;

  /**
   * Imagery and tilt, chosen by the reader and remembered per browser.
   *
   * Google's own `mapTypeControl` was briefly used and does most of this, but
   * it forgets the choice between visits and has no notion of tilt — so "3D"
   * was unreachable through it. Ours is off to the left, clear of Google's own
   * controls in the other three corners.
   */
  const [mapPreferences, setMapPreferences] = useMapPreferences();

  // Fit to everything, technicians and properties alike, rather than centring
  // on a fixed point: this office works one metropolitan area today, but a
  // hard-coded centre is the kind of thing that silently stops making sense
  // when a second one is added.
  //
  // Not simply everything. A handset reporting from another continent — a test
  // device, a phone that travelled — would otherwise drag the view out to a
  // world map on which neither it nor the properties could be read. The
  // properties anchor the frame; an outlier is still drawn, it just does not
  // get to decide the zoom.
  const points = useMemo(() => pointsToFit(properties, positions), [positions, properties]);

  const selectedPosition = useMemo(
    () => positions.find((position) => position.technicianId === selectedTechnicianId) ?? null,
    [positions, selectedTechnicianId],
  );

  // Where the selected technician's work is, for the case where they have no
  // position to fly to yet.
  const selectedStops = useMemo<[number, number][]>(
    () =>
      highlightedBuildingIds
        ? properties
            .filter((property) => highlightedBuildingIds.has(property.id))
            .map((property) => [property.latitude, property.longitude])
        : [],
    [highlightedBuildingIds, properties],
  );

  // Who is on the map, not where they are. Keyed on `technicianId` rather than
  // the position row's own id, which is a new row for every fix and would make
  // this change as often as the coordinates do.
  const fitKey = useMemo(
    () =>
      [
        ...positions.map((position) => position.technicianId).sort(),
        ...properties.map((property) => property.id).sort(),
      ].join('|'),
    [positions, properties],
  );

  /** Every technician's last few minutes of fixes, for how they are moving. */
  const tracks = useMotionTracks(positions);

  /**
   * What the camera is about, and whether the reader has taken it.
   *
   * The most recent pick wins: a technician, or a property -- including a stop
   * picked inside the selected technician's day, which moves the map to that
   * address while the technician stays selected. Letting go of the property
   * goes back to following the technician.
   */
  const [focus, setFocus] = useState<CameraFocus>({ kind: 'OVERVIEW' });
  const [readerMoved, setReaderMoved] = useState(false);
  const [recenterRequest, setRecenterRequest] = useState(0);

  useEffect(() => {
    if (selectedTechnicianId) {
      setFocus({ kind: 'TECHNICIAN', technicianId: selectedTechnicianId });
      setReaderMoved(false);
    } else {
      setFocus(
        selectedPropertyId
          ? { kind: 'PROPERTY', propertyId: selectedPropertyId }
          : { kind: 'OVERVIEW' },
      );
    }
    // Runs for the technician pick; the property is read, not depended on.
  }, [selectedTechnicianId]);

  useEffect(() => {
    if (selectedPropertyId) {
      setFocus({ kind: 'PROPERTY', propertyId: selectedPropertyId });
      setReaderMoved(false);
    } else if (selectedTechnicianId) {
      setFocus({ kind: 'TECHNICIAN', technicianId: selectedTechnicianId });
      setReaderMoved(false);
    } else {
      setFocus({ kind: 'OVERVIEW' });
    }
    // As above, the other way round.
  }, [selectedPropertyId]);

  const readerMovedTheMap = useCallback(() => setReaderMoved(true), []);
  const recenter = useCallback(() => {
    setReaderMoved(false);
    setRecenterRequest((count) => count + 1);
  }, []);

  /**
   * A marker click picks that technician -- and on the one already picked,
   * re-centres on them, rather than letting go of the person being watched.
   */
  const selectFromMap = useCallback(
    (technicianId: string) => {
      if (technicianId === selectedTechnicianId) recenter();
      else onSelectTechnician?.(technicianId);
    },
    [onSelectTechnician, recenter, selectedTechnicianId],
  );

  // The first stop still ahead of them, by the same rule the route layer uses
  // to colour its next stop.
  const nextStop = useMemo(() => {
    if (!route?.geometry.length) return null;
    const current = new Set(currentInspectionIds ?? []);
    const index = route.stops.findIndex((stop) => !current.has(stop.inspectionId));
    const stop = route.stops[index];
    if (!stop) return null;
    return { name: stop.propertyName, driveSeconds: route.legs[index]?.durationSeconds ?? null };
  }, [currentInspectionIds, route]);

  const recenterSubject =
    focus.kind === 'TECHNICIAN'
      ? (selectedPosition?.technician?.displayName ?? 'the technician')
      : focus.kind === 'PROPERTY'
        ? 'the property'
        : 'everyone';

  if (!API_KEY)
    return (
      <MapUnavailable>
        The map needs a Google Maps browser key.
        <br />
        Set <code className="font-mono">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> and rebuild.
      </MapUnavailable>
    );

  const now = Date.now();

  return (
    <div className="relative h-full w-full">
      <APIProvider apiKey={API_KEY}>
        <MapOrReason>
        <GoogleMap
          className="h-full w-full rounded-lg"
          colorScheme={colorScheme}
          defaultCenter={FALLBACK_CENTER}
          defaultZoom={FALLBACK_ZOOM}
          disableDefaultUI={false}
          gestureHandling="greedy"
          mapId={MAP_ID}
          // Ours instead, which remembers the choice and can also tilt.
          mapTypeControl={false}
          mapTypeId={mapPreferences.mapType}
          // One world. Google repeats the map horizontally when zoomed out, so
          // without this a technician can appear in two places at once and the
          // properties are drawn three times over.
          restriction={{ latLngBounds: WORLD_BOUNDS, strictBounds: false }}
          streetViewControl={false}
          /* 45° is what Google's own 3D control gives, and the only angle the
             vector basemap has buildings modelled for. Raster imagery ignores
             it rather than refusing, so the setting is harmless where it does
             nothing. */
          tilt={mapPreferences.tilted ? 45 : 0}
        >
          <CameraDirector
            fallback={selectedStops}
            fitKey={fitKey}
            focus={focus}
            followed={selectedPosition}
            onReaderMoved={readerMovedTheMap}
            points={points}
            properties={properties}
            readerMoved={readerMoved}
            recenterRequest={recenterRequest}
          />

          {/* Under the markers and over the properties: the route is context for
              the pins, not a thing to be read on its own. */}
          <RouteLayer currentInspectionIds={currentInspectionIds} route={route} />
          <AirTravelLayer route={route} />

          <PropertyLayer
            highlighted={highlightedBuildingIds}
            properties={properties}
            selectedPropertyId={selectedPropertyId}
          />

          {positions.map((position) => (
            // Keyed on the technician, not the fix. The fix's id is new on
            // every report, which remounted the marker each time -- so there
            // was nothing to slide, only a marker destroyed and drawn again.
            <Fragment key={position.technicianId}>
              {position.accuracyMeters && position.accuracyMeters > 25 ? (
                <AccuracyRing
                  latitude={position.latitude}
                  longitude={position.longitude}
                  radiusMeters={position.accuracyMeters}
                />
              ) : null}
              <TechnicianMarker
                dim={
                  Boolean(selectedTechnicianId) && position.technicianId !== selectedTechnicianId
                }
                motion={motionOf(tracks.get(position.technicianId) ?? [], now)}
                onSelect={selectFromMap}
                position={position}
                selected={position.technicianId === selectedTechnicianId}
              />
            </Fragment>
          ))}

          {/* Controls inside the map rather than over it, so they stay on
              screen in fullscreen and Google lays them out around its own. */}
          <MapControl position={ControlPosition.RIGHT_BOTTOM}>
            <RecenterControl
              following={focus.kind === 'TECHNICIAN' && Boolean(selectedPosition)}
              onRecenter={recenter}
              readerMoved={readerMoved}
              subject={recenterSubject}
            />
          </MapControl>
          {selectedPosition ? (
            <MapControl position={ControlPosition.BOTTOM_CENTER}>
              <TechnicianHud
                nextStop={nextStop}
                position={selectedPosition}
                track={tracks.get(selectedPosition.technicianId) ?? []}
              />
            </MapControl>
          ) : null}
        </GoogleMap>
        </MapOrReason>
      </APIProvider>
      {/* Outside `APIProvider` on purpose: the settings still open, and still
          remember, when Google will not load at all. */}
      <div className="absolute top-3 left-3 z-10">
        <MapSettings onChange={setMapPreferences} preferences={mapPreferences} />
      </div>
    </div>
  );
}
