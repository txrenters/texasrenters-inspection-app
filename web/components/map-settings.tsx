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
}

/** Roadmap, flat. The plainest reading of a map full of pins. */
export const DEFAULT_PREFERENCES: MapPreferences = { mapType: 'roadmap', tilted: false };

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
}: {
  preferences: MapPreferences;
  onChange: (next: Partial<MapPreferences>) => void;
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
