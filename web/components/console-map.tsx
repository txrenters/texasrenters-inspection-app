'use client';

import 'mapbox-gl/dist/mapbox-gl.css';

import { useEffect, type ReactNode } from 'react';
import Map, { FullscreenControl, NavigationControl, useMap } from 'react-map-gl/mapbox';
import { useTheme } from 'next-themes';

import { useMapFailure } from '@/components/map-error';
import { GroupingRadiusLayer, type MapPoint } from '@/components/map-layers';
import {
  CrewLayers,
  PortfolioLayers,
  type CrewOptions,
  type PortfolioOptions,
} from '@/components/map-portfolio';
import { MAPBOX_TOKEN, mapboxTokenProblem } from '@/components/mapbox-token';
import { MapSettings, useMapPreferences, type MapTypeKey } from '@/components/map-settings';
import { usePermissions } from '@/lib/auth';
import { usePropertyLocations, useTechnicianLocations } from '@/lib/queries';

/**
 * One map, for every map in this console.
 *
 * The office asked for this twice. The technician map and the quarter's maps
 * were built separately, so a feature added to one simply did not exist on the
 * other — the grouping radius went onto the technician map, and the office then
 * went looking for it on the plan they actually rebuild a quarter against.
 * "Create the unified map so we can use it everywhere."
 *
 * So the shell lives here: the token, the basemap and its dark variant, the
 * reader's remembered map type and tilt, the grouping radius, the zoom and
 * fullscreen controls, and the one error that is worth taking a map away for.
 * What each page puts *on* the map — pins, routes, rings, circles — is its own,
 * and arrives as children.
 *
 * Must be loaded with `ssr: false` by every page that uses it. Mapbox GL
 * touches `window` and measures its container, neither of which exists on a
 * server.
 */

/**
 * The map each of the reader's choices draws on.
 *
 * Only the roadmap has a dark variant. Satellite imagery is neither light nor
 * dark — it is a photograph — and swapping it for something darker at night
 * would be changing the data to match the furniture.
 */
const MAP_STYLES: Record<MapTypeKey, { light: string; dark: string }> = {
  roadmap: {
    light: 'mapbox://styles/mapbox/streets-v12',
    dark: 'mapbox://styles/mapbox/dark-v11',
  },
  terrain: {
    light: 'mapbox://styles/mapbox/outdoors-v12',
    dark: 'mapbox://styles/mapbox/outdoors-v12',
  },
  satellite: {
    light: 'mapbox://styles/mapbox/satellite-v9',
    dark: 'mapbox://styles/mapbox/satellite-v9',
  },
  hybrid: {
    light: 'mapbox://styles/mapbox/satellite-streets-v12',
    dark: 'mapbox://styles/mapbox/satellite-streets-v12',
  },
};

/** Said plainly, rather than rendering a grey rectangle nobody can diagnose. */
export function MapUnavailable({ children }: { children: ReactNode }) {
  return (
    <div className="bg-card text-muted-foreground flex h-full w-full items-center justify-center rounded-lg border p-6 text-center text-sm">
      <p>{children}</p>
    </div>
  );
}

/**
 * Tilt, applied to the live camera rather than through a controlled prop.
 *
 * Making `pitch` a prop of `<Map>` puts the camera under React's control, and
 * then every fly-to and follow has to round-trip through state to survive a
 * render. This leaves the camera where it belongs — with the map — and only
 * nudges the angle when the reader asks for a different one.
 *
 * `easeTo` carries no `originalEvent`, so this does not read as the reader
 * taking the camera.
 */
function MapPitch({ degrees }: { degrees: number }) {
  const { current: map } = useMap();

  useEffect(() => {
    if (!map) return;
    map.easeTo({ pitch: degrees, duration: 300 });
  }, [map, degrees]);

  return null;
}

/** Stable empties, so a map with nothing on it does not re-render its layers. */
const NO_PROPERTIES: readonly never[] = [];

export function ConsoleMap({
  children,
  crew,
  initialView,
  portfolio,
  radiusPoints = [],
  settingsSlot = true,
  unavailable,
}: {
  children?: ReactNode;
  /** Where the map opens, before anything has been framed. */
  initialView: { longitude: number; latitude: number; zoom: number };
  /**
   * What the grouping-radius overlay draws around, when the reader turns it on.
   *
   * Empty is a map that simply has nothing to group — the control still
   * appears, because it is a property of the console's map rather than of one
   * page, and a control that comes and goes between pages is one nobody
   * remembers exists.
   */
  radiusPoints?: readonly MapPoint[];
  /**
   * Every property, drawn as the Group maker draws it: a disc each in its
   * group's colour that opens on a click, and geofence rings.
   *
   * **This is what makes the console one map.** The office asked for the
   * technician map and the quarter's maps to agree -- "same geocoding, same
   * Venn diagram" -- and they could not while each drew its own. Turned on,
   * the grouping radius is drawn around the whole portfolio as well, so the
   * overlaps read the same on every page: which properties could share a day
   * is a fact about the portfolio, not about whichever page it is looked at on.
   *
   * `true` fetches the portfolio; an object passes the page's own list and
   * says which properties it is about.
   */
  portfolio?: boolean | PortfolioOptions;
  /**
   * The crew, as the technician map draws them. Behind `technicians:locate`
   * wherever it is turned on: where a named person is at a given minute is not
   * something a schedule-reader gets for free because the map is shared.
   */
  crew?: boolean | CrewOptions;
  /** The map-type and radius control. Off for a map that is a thumbnail. */
  settingsSlot?: boolean;
  /**
   * Something to say instead of a map, decided by the page — "no visit in this
   * quarter has a day yet", and the like. The token and a refused map are
   * handled here, because those are the same on every page.
   */
  unavailable?: ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === 'dark';
  const [preferences, setPreferences] = useMapPreferences();
  const [failure, onError] = useMapFailure();

  /**
   * The portfolio and the crew, fetched here only when a page turns them on
   * and does not hand its own over -- and each only behind its own permission,
   * so a map never asks for something it knows will be refused.
   */
  const permissions = usePermissions();
  const portfolioOptions = portfolio === true ? {} : portfolio || null;
  const crewOptions = crew === true ? {} : crew || null;
  const fetchedProperties = usePropertyLocations(
    Boolean(portfolioOptions) && !portfolioOptions?.properties && permissions.has('properties:read'),
  );
  const fetchedCrew = useTechnicianLocations(
    Boolean(crewOptions) && !crewOptions?.positions && permissions.has('technicians:locate'),
  );
  const properties = portfolioOptions?.properties ?? fetchedProperties.data ?? NO_PROPERTIES;
  const positions = crewOptions?.positions ?? fetchedCrew.data ?? NO_PROPERTIES;

  const tokenProblem = mapboxTokenProblem(MAPBOX_TOKEN);
  if (tokenProblem) return <MapUnavailable>{tokenProblem}</MapUnavailable>;
  if (failure) return <MapUnavailable>{failure}</MapUnavailable>;
  if (unavailable) return <MapUnavailable>{unavailable}</MapUnavailable>;

  const style = MAP_STYLES[preferences.mapType];

  return (
    // `isolate`: the map is its own stacking context. Pages order their pins
    // with z-indexes in the hundreds, and without this those competed with the
    // whole page -- a map's pins drew over a dialog opened above it.
    <div className="relative isolate h-full w-full">
      <Map
        initialViewState={initialView}
        mapStyle={dark ? style.dark : style.light}
        mapboxAccessToken={MAPBOX_TOKEN}
        onError={onError}
        /* One world. Mapbox repeats the map horizontally when zoomed out, so
           without this a technician can appear in two places at once and the
           properties are drawn three times over. */
        renderWorldCopies={false}
        style={{ width: '100%', height: '100%', borderRadius: '0.5rem' }}
      >
        {/* 45° is the angle a vector basemap has buildings modelled for. */}
        <MapPitch degrees={preferences.tilted ? 45 : 0} />

        {/* Before the children, so the circles sit under whatever the page
            draws on top of them. Layer order is mount order.

            Around the whole portfolio whenever the portfolio is shown: the
            same Venn diagram on every page. */}
        <GroupingRadiusLayer
          points={portfolioOptions ? properties : radiusPoints}
          radiusMeters={preferences.groupingRadiusMeters}
        />
        {portfolioOptions ? (
          <PortfolioLayers
            highlighted={portfolioOptions.highlighted ?? null}
            otherProperties={preferences.otherProperties}
            properties={properties}
            selectedPropertyId={portfolioOptions.selectedPropertyId ?? null}
            zones={preferences.zones}
          />
        ) : null}

        {children}

        {/* After the page's own layers, as the technician map always drew
            them: the ring of a vague fix over the route, not under it. */}
        {crewOptions ? (
          <CrewLayers
            onSelect={crewOptions.onSelect}
            positions={positions}
            selectedTechnicianId={crewOptions.selectedTechnicianId ?? null}
            tracks={crewOptions.tracks}
          />
        ) : null}

        <NavigationControl position="top-right" showCompass visualizePitch />
        <FullscreenControl position="top-right" />
      </Map>

      {/* Outside the map on purpose: the settings still open, and still
          remember, when the map itself will not load. */}
      {settingsSlot ? (
        <div className="absolute top-3 left-3 z-10">
          <MapSettings onChange={setPreferences} portfolio={Boolean(portfolioOptions)} preferences={preferences} />
        </div>
      ) : null}
    </div>
  );
}
