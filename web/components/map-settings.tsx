'use client';

import { ChevronDownIcon, LayersIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * What the map looks like, chosen by the reader and remembered.
 *
 * Google's own `mapTypeControl` offers most of this and was briefly used, but
 * it cannot do the two things that matter here: it does not remember the
 * choice between visits, and it has no notion of tilt — so "3D" would have
 * been unreachable through it.
 *
 * Per browser rather than per account. This is a viewing preference, like a
 * zoom level, and it is not worth a column on a user row or a round trip to
 * read back.
 */

/** The four Google offers that are useful here, in the order they are read. */
export const MAP_TYPES = {
  roadmap: 'Roadmap',
  terrain: 'Terrain',
  satellite: 'Satellite',
  hybrid: 'Hybrid',
} as const;

export type MapTypeKey = keyof typeof MAP_TYPES;

export interface MapPreferences {
  mapType: MapTypeKey;
  /**
   * Tilted 45°, which is what "3D" means on a Google vector map.
   *
   * Not a map type — a camera angle, and one only a vector map can honour.
   * Switching to satellite or terrain drops to raster imagery, where the tilt
   * is simply ignored rather than refused, so the toggle stays available and
   * quietly does nothing there.
   */
  tilted: boolean;

  /**
   * A circle of this radius around every property, to judge grouping by eye.
   *
   * Off by default and nothing to do with the orange ring, which is the
   * distance a technician's *time* is measured from. This one answers a
   * different question the office asked while rebuilding a quarter: which
   * properties are near enough to each other to be worth visiting on one day.
   *
   * A few sizes rather than a slider because the office is comparing
   * candidate rules, not tuning one -- and where the circles overlap is the
   * thing being read, which a number in a box does not show.
   */
  groupingRadiusMeters: GroupingRadius;

  /** Each zone's ground and fence under the properties, as the Group maker draws them. */
  zones: boolean;

  /**
   * The active properties off the benefit package, as yellow discs. On by
   * default: the office asked for every active property on the technician map,
   * not only the package's (2026-10-01). Off leaves the package's alone.
   */
  otherProperties: boolean;
}

/**
 * Off, or one of the sizes the office is weighing up.
 *
 * 2 km was asked for on the grounds that it is still a reasonable drive, and
 * it is: by the planner's own estimate a 2 km hop is about six minutes, well
 * inside the twenty a day refuses to exceed between properties. 3 km follows
 * for the same reason, at about seven and a half.
 *
 * **What a wider circle does not do is make the days bigger.** On this
 * portfolio, 23% of properties have no neighbour at all within 2 km and only
 * 12% have the eight a day of nine would need; at 3 km it is 9% and 21%. The
 * days are not built by this radius -- they are chained from nearest
 * neighbours up to the leg limit, which already reaches about eleven
 * kilometres. These circles are a lens for reading the portfolio, not the rule
 * that groups it.
 */
export const GROUPING_RADII = [0, 500, 1_000, 2_000, 3_000] as const;
export type GroupingRadius = (typeof GROUPING_RADII)[number];

/** Roadmap, flat, no circles, no zones, every property. The plainest reading of a map full of pins. */
export const DEFAULT_PREFERENCES: MapPreferences = {
  mapType: 'roadmap',
  tilted: false,
  groupingRadiusMeters: 0,
  zones: false,
  otherProperties: true,
};

const STORAGE_KEY = 'texasrenters.map-preferences';

/**
 * Read once on mount, never during render.
 *
 * `localStorage` does not exist on the server, and reading it in a `useState`
 * initialiser makes the first client render disagree with the HTML that was
 * sent — a hydration mismatch that React resolves by throwing the markup away.
 * So the default renders first and the stored choice arrives immediately after.
 */
export function useMapPreferences() {
  const [preferences, setPreferences] = useState<MapPreferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as Partial<MapPreferences>;
      setPreferences({
        // Validated rather than trusted: a stored value from an older build, or
        // one somebody edited, must not reach Google as a map type it will
        // reject.
        mapType: stored.mapType && stored.mapType in MAP_TYPES ? stored.mapType : DEFAULT_PREFERENCES.mapType,
        tilted: typeof stored.tilted === 'boolean' ? stored.tilted : DEFAULT_PREFERENCES.tilted,
        // Same reasoning as the map type: a stored number from another build
        // must not reach Google as a radius, so only the offered ones pass.
        groupingRadiusMeters: GROUPING_RADII.includes(stored.groupingRadiusMeters as GroupingRadius)
          ? (stored.groupingRadiusMeters as GroupingRadius)
          : DEFAULT_PREFERENCES.groupingRadiusMeters,
        zones: typeof stored.zones === 'boolean' ? stored.zones : DEFAULT_PREFERENCES.zones,
        otherProperties:
          typeof stored.otherProperties === 'boolean' ? stored.otherProperties : DEFAULT_PREFERENCES.otherProperties,
      });
    } catch {
      // Private windows throw on access. Losing a preference is nothing; taking
      // the map down with it would not be.
    }
  }, []);

  const update = useCallback((next: Partial<MapPreferences>) => {
    setPreferences((current) => {
      const merged = { ...current, ...next };
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {
        // As above: the map still works, it just forgets.
      }
      return merged;
    });
  }, []);

  return [preferences, update] as const;
}

export function MapSettings({
  preferences,
  onChange,
  portfolio = false,
}: {
  preferences: MapPreferences;
  onChange: (next: Partial<MapPreferences>) => void;
  /** The map draws the portfolio, so how it is drawn can be chosen here. */
  portfolio?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Labelled, not an icon.
            
            This was a bare `LayersIcon` in an icon button, and it was missed
            entirely: a small unlabelled glyph in the corner of a map full of
            other small glyphs reads as decoration. Naming the current map type
            makes it obviously a control, and says what it is currently set to
            without opening it. */}
        <Button aria-label="Change the map type" size="sm" variant="secondary">
          <LayersIcon />
          {MAP_TYPES[preferences.mapType]}
          {preferences.tilted ? ' · 3D' : null}
          <ChevronDownIcon className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel>Map</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(value) => onChange({ mapType: value as MapTypeKey })}
          value={preferences.mapType}
        >
          {Object.entries(MAP_TYPES).map(([key, label]) => (
            <DropdownMenuRadioItem key={key} value={key}>
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={preferences.tilted}
          /* Only the vector roadmap can tilt. Disabled rather than hidden on the
             others, so the option does not appear to vanish when somebody
             switches to satellite and then cannot find it again. */
          disabled={preferences.mapType !== 'roadmap'}
          onCheckedChange={(checked) => onChange({ tilted: checked })}
        >
          3D
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {/* Named for what it is for, not for what it draws. Somebody opening
            this menu while rebuilding a quarter is asking "which of these
            could share a day", and "Grouping radius" answers that where
            "Circles" would not. */}
        <DropdownMenuLabel>Grouping radius</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(value) =>
            onChange({ groupingRadiusMeters: Number(value) as GroupingRadius })
          }
          value={String(preferences.groupingRadiusMeters)}
        >
          {GROUPING_RADII.map((metres) => (
            <DropdownMenuRadioItem key={metres} value={String(metres)}>
              {metres === 0 ? 'None' : metres < 1_000 ? `${metres} m` : `${metres / 1_000} km`}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {portfolio ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Properties</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={preferences.zones}
              onCheckedChange={(checked) => onChange({ zones: checked })}
            >
              Zones
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={preferences.otherProperties}
              onCheckedChange={(checked) => onChange({ otherProperties: checked })}
            >
              Non-TBP properties
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
