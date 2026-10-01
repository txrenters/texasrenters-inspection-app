import type { PropertyPosition } from '@texasrenters/shared';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CameraDirector, MAP_OVERLAY_ATTRIBUTE, type CameraFocus } from './map-camera';

/**
 * The map stops pulling the view out from under the reader.
 *
 * Reported: zoom in anywhere on the map and, a few seconds later, it is back on
 * Moses at zoom 15. Every position pushed over the socket re-ran the effect
 * that flies to the selected technician, and with nobody selected every
 * refetch re-fitted the whole patch -- so nobody could look at a street, or a
 * property, while a technician was driving.
 *
 * Written against Mapbox since the console left Google. The behaviour under
 * test did not change; how the map is asked and what it reports back did.
 * Mapbox takes a centre as `[longitude, latitude]` -- the other way round from
 * Google -- and says whether a person caused a camera move, which the Google
 * version had to infer from pointer and wheel events inside a time window.
 */

type Handler = (event: unknown) => void;

function fakeMap() {
  const container = document.createElement('div');
  document.body.append(container);
  const handlers = new Map<string, Set<Handler>>();
  return {
    container,
    easeTo: vi.fn(),
    fitBounds: vi.fn(),
    getZoom: vi.fn(() => 12),
    on: (event: string, handler: Handler) => {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
    },
    off: (event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler);
    },
    /**
     * What Mapbox would fire. A camera event carries `originalEvent` when a
     * person caused it and nothing at all when the map moved itself.
     */
    emit: (event: string, originalEvent?: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler({ originalEvent });
    },
  };
}

let map: ReturnType<typeof fakeMap>;

vi.mock('react-map-gl/mapbox', () => ({
  useMap: () => ({ current: map }),
}));

const MOSES = 'tech-moses';
const onTheFreeway = { latitude: 29.5379, longitude: -95.1288 };
const furtherUp = { latitude: 29.5404, longitude: -95.126 };
const property: PropertyPosition = {
  id: 'building-1',
  name: '2958 Illusion Rd',
  addressLine1: '2958 Illusion Rd',
  city: 'Pearland',
  latitude: 29.53,
  longitude: -95.28,
} as PropertyPosition;

type Props = Parameters<typeof CameraDirector>[0];

function props(over: Partial<Props> = {}): Props {
  return {
    fallback: [],
    fitKey: '',
    focus: { kind: 'OVERVIEW' },
    followed: null,
    onReaderMoved: vi.fn(),
    points: [],
    properties: [],
    readerMoved: false,
    recenterRequest: 0,
    ...over,
  };
}

const following: CameraFocus = { kind: 'TECHNICIAN', technicianId: MOSES };
const NOW = Date.parse('2026-09-15T19:51:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  map = fakeMap();
});

afterEach(() => {
  vi.useRealTimers();
  map.container.remove();
});

describe('following a technician', () => {
  it('goes to them once when they are picked', () => {
    render(<CameraDirector {...props({ focus: following, followed: onTheFreeway })} />);

    expect(map.easeTo).toHaveBeenCalledWith({ center: [-95.1288, 29.5379], zoom: 15 });
  });

  it('does not move when their position is merely delivered again', () => {
    // The refetch and every socket frame rebuild the objects; nothing moved.
    const { rerender } = render(
      <CameraDirector {...props({ focus: following, followed: onTheFreeway })} />,
    );
    map.easeTo.mockClear();

    rerender(
      <CameraDirector
        {...props({
          fallback: [[29.5, -95.2]],
          focus: { kind: 'TECHNICIAN', technicianId: MOSES },
          followed: { ...onTheFreeway },
          points: [[29.5, -95.2]],
          properties: [property],
        })}
      />,
    );

    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it('keeps them in the middle as they drive, leaving the zoom alone', () => {
    const { rerender } = render(
      <CameraDirector {...props({ focus: following, followed: onTheFreeway })} />,
    );
    map.easeTo.mockClear();

    rerender(<CameraDirector {...props({ focus: following, followed: furtherUp })} />);

    // No `zoom` key at all: the zoom belongs to the reader once they have set it.
    expect(map.easeTo).toHaveBeenLastCalledWith({ center: [-95.126, 29.5404] });
  });

  it('stops following the moment the reader moves the map', () => {
    const onReaderMoved = vi.fn();
    const { rerender } = render(
      <CameraDirector {...props({ focus: following, followed: onTheFreeway, onReaderMoved })} />,
    );

    map.emit('dragstart', new PointerEvent('pointerdown'));
    expect(onReaderMoved).toHaveBeenCalled();

    map.easeTo.mockClear();
    rerender(
      <CameraDirector
        {...props({ focus: following, followed: furtherUp, onReaderMoved, readerMoved: true })}
      />,
    );
    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it('goes back to them, and zooms in again, on Re-center', () => {
    const { rerender } = render(
      <CameraDirector {...props({ focus: following, followed: onTheFreeway, readerMoved: true })} />,
    );
    map.easeTo.mockClear();

    rerender(
      <CameraDirector
        {...props({ focus: following, followed: furtherUp, readerMoved: false, recenterRequest: 1 })}
      />,
    );

    expect(map.easeTo).toHaveBeenCalledWith({ center: [-95.126, 29.5404], zoom: 15 });
  });

  it('frames their stops when they have not reported a position', () => {
    render(
      <CameraDirector
        {...props({
          fallback: [
            [29.53, -95.28],
            [29.6, -95.1],
          ],
          focus: following,
        })}
      />,
    );

    expect(map.fitBounds).toHaveBeenCalled();
    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it('never dives past the fit ceiling, however tight the day is', () => {
    render(
      <CameraDirector
        {...props({
          fallback: [
            [29.53, -95.28],
            [29.5301, -95.2801],
          ],
          focus: following,
        })}
      />,
    );

    // Mapbox takes the ceiling with the fit, so there is no second, racing
    // correction the way there was under Google.
    expect(map.fitBounds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxZoom: 15 }),
    );
  });
});

describe('telling the reader’s moves from the map’s own', () => {
  function renderFollowing(onReaderMoved = vi.fn()) {
    render(<CameraDirector {...props({ focus: following, followed: onTheFreeway, onReaderMoved })} />);
    return onReaderMoved;
  }

  it('counts a scroll-wheel zoom', () => {
    const onReaderMoved = renderFollowing();

    map.emit('zoomstart', new WheelEvent('wheel'));

    expect(onReaderMoved).toHaveBeenCalledTimes(1);
  });

  it('counts a drag, a rotate and a tilt', () => {
    const onReaderMoved = renderFollowing();

    map.emit('dragstart', new PointerEvent('pointerdown'));
    map.emit('rotatestart', new PointerEvent('pointerdown'));
    map.emit('pitchstart', new PointerEvent('pointerdown'));

    expect(onReaderMoved).toHaveBeenCalledTimes(3);
  });

  /**
   * The whole reason the guesswork went. Under Google a fly-to fired the same
   * events a drag did, and the only defence was a clock: anything within a
   * second and a half of the map moving itself was assumed to be the map. A
   * reader who happened to click during those frames lost their view anyway.
   */
  it('does not count a camera change nobody touched the map for', () => {
    const onReaderMoved = renderFollowing();

    map.emit('zoomstart');
    map.emit('dragstart');
    map.emit('pitchstart');

    expect(onReaderMoved).not.toHaveBeenCalled();
  });

  it('does not count touching this console’s own controls on the map', () => {
    const onReaderMoved = renderFollowing();
    const panel = document.createElement('div');
    panel.setAttribute(MAP_OVERLAY_ATTRIBUTE, '');
    const recenter = document.createElement('button');
    panel.append(recenter);
    map.container.append(panel);

    // Mapbox reports the element the gesture actually started on, so a press on
    // Re-center is recognisably not a press on the map.
    map.emit('dragstart', { target: recenter });
    map.emit('zoomstart', { target: recenter });

    expect(onReaderMoved).not.toHaveBeenCalled();
  });
});

describe('the overview, with nobody picked', () => {
  const houston: [number, number][] = [
    [29.53, -95.28],
    [29.76, -95.37],
  ];

  it('frames everything once it arrives', () => {
    const { rerender } = render(<CameraDirector {...props()} />);
    expect(map.fitBounds).not.toHaveBeenCalled();

    rerender(<CameraDirector {...props({ fitKey: 'tech-moses|building-1', points: houston })} />);

    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('does not re-frame when somebody merely moves', () => {
    const { rerender } = render(
      <CameraDirector {...props({ fitKey: 'tech-moses|building-1', points: houston })} />,
    );

    rerender(
      <CameraDirector
        {...props({ fitKey: 'tech-moses|building-1', points: [[29.54, -95.27], houston[1]!] })}
      />,
    );

    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('re-frames when somebody comes on shift -- unless the reader has moved the map', () => {
    const { rerender } = render(
      <CameraDirector {...props({ fitKey: 'tech-moses|building-1', points: houston })} />,
    );

    rerender(
      <CameraDirector {...props({ fitKey: 'tech-kevin|tech-moses|building-1', points: houston })} />,
    );
    expect(map.fitBounds).toHaveBeenCalledTimes(2);

    rerender(
      <CameraDirector
        {...props({
          fitKey: 'tech-amy|tech-kevin|tech-moses|building-1',
          points: houston,
          readerMoved: true,
        })}
      />,
    );
    expect(map.fitBounds).toHaveBeenCalledTimes(2);
  });

  it('keeps the reader’s view when they let go of a technician', () => {
    const { rerender } = render(
      <CameraDirector
        {...props({ fitKey: 'k', focus: following, followed: onTheFreeway, points: houston })}
      />,
    );
    map.fitBounds.mockClear();

    rerender(
      <CameraDirector {...props({ fitKey: 'k', points: houston, readerMoved: true })} />,
    );

    expect(map.fitBounds).not.toHaveBeenCalled();
  });
});

describe('a picked property', () => {
  it('is flown to once, not again on every refetch of the list', () => {
    const focus: CameraFocus = { kind: 'PROPERTY', propertyId: property.id };
    const { rerender } = render(<CameraDirector {...props({ focus, properties: [property] })} />);

    expect(map.easeTo).toHaveBeenCalledWith({ center: [-95.28, 29.53], zoom: 18 });

    rerender(<CameraDirector {...props({ focus: { ...focus }, properties: [{ ...property }] })} />);

    expect(map.easeTo).toHaveBeenCalledTimes(1);
  });
});
