import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One map for the whole console, and the permissions do not come with it.
 *
 * The office asked for the technician map and the quarter's maps to be one
 * map -- "same geocoding, same Venn diagram" -- so the plan's maps now draw
 * the crew and the portfolio exactly as the technician map does.
 *
 * That makes this the place a boundary could quietly leak. Where a named
 * person is at a given minute is behind `technicians:locate`, not behind the
 * planning grant: somebody who can read a schedule does not thereby get to
 * watch the crew. Sharing the map must not share the key.
 */

const granted = new Set<string>();
// Typed rather than given a parameter, so `mock.calls` knows what was passed.
const useTechnicianLocations = vi.fn<(enabled: boolean) => { data: undefined }>(() => ({
  data: undefined,
}));
const usePropertyLocations = vi.fn<(enabled: boolean) => { data: undefined }>(() => ({
  data: undefined,
}));

vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: (permission: string) => granted.has(permission) }),
}));
vi.mock('@/lib/queries', () => ({
  useTechnicianLocations: (enabled: boolean) => useTechnicianLocations(enabled),
  usePropertyLocations: (enabled: boolean) => usePropertyLocations(enabled),
}));
// No WebGL here, and nothing under test draws: the map is stood in for.
vi.mock('react-map-gl/mapbox', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  FullscreenControl: () => null,
  NavigationControl: () => null,
  Layer: () => null,
  Marker: () => null,
  Popup: () => null,
  Source: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useMap: () => ({ current: undefined }),
}));
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}));

const { ConsoleMap } = await import('./console-map');

const VIEW = { longitude: -95.37, latitude: 29.76, zoom: 10 };
const lastEnabled = (hook: typeof useTechnicianLocations) => hook.mock.calls.at(-1)?.[0];

beforeEach(() => {
  granted.clear();
  useTechnicianLocations.mockClear();
  usePropertyLocations.mockClear();
});

describe('the crew on a shared map', () => {
  it('is not asked for without technicians:locate, whatever else is held', () => {
    granted.add('planning:read');
    granted.add('properties:read');

    render(<ConsoleMap crew initialView={VIEW} />);

    expect(lastEnabled(useTechnicianLocations)).toBe(false);
  });

  it('is asked for with technicians:locate', () => {
    granted.add('technicians:locate');

    render(<ConsoleMap crew initialView={VIEW} />);

    expect(lastEnabled(useTechnicianLocations)).toBe(true);
  });

  it('is not asked for by a map that did not turn it on', () => {
    granted.add('technicians:locate');

    render(<ConsoleMap initialView={VIEW} />);

    expect(lastEnabled(useTechnicianLocations)).toBe(false);
  });

  /**
   * The technician map already has the crew, filtered by its own roster. A
   * second request for the same list would be waste, and would also ignore
   * the filter the reader chose.
   */
  it('is not fetched again when the page hands its own over', () => {
    granted.add('technicians:locate');

    render(<ConsoleMap crew={{ positions: [] }} initialView={VIEW} />);

    expect(lastEnabled(useTechnicianLocations)).toBe(false);
  });
});

describe('the portfolio on a shared map', () => {
  it('is asked for behind properties:read alone', () => {
    // Not behind technicians:locate: where a property is says nothing about
    // where a person is, and the planning pages need it without that grant.
    granted.add('properties:read');

    render(<ConsoleMap initialView={VIEW} portfolio />);

    expect(lastEnabled(usePropertyLocations)).toBe(true);
  });

  it('is not asked for without properties:read', () => {
    granted.add('technicians:locate');

    render(<ConsoleMap initialView={VIEW} portfolio />);

    expect(lastEnabled(usePropertyLocations)).toBe(false);
  });

  it('is not fetched again when the page hands its own over', () => {
    granted.add('properties:read');

    render(<ConsoleMap initialView={VIEW} portfolio={{ properties: [] }} />);

    expect(lastEnabled(usePropertyLocations)).toBe(false);
  });
});
