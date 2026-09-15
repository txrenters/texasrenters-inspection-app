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
 */

type Handler = () => void;

function fakeMap() {
  const container = document.createElement('div');
  document.body.append(container);
  const handlers = new Map<string, Set<Handler>>();
  return {
    container,
    getDiv: () => container,
    panTo: vi.fn(),
    setZoom: vi.fn(),
    getZoom: vi.fn(() => 12),
    fitBounds: vi.fn(),
    addListener: (event: string, handler: Handler) => {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
      return { remove: () => set.delete(handler) };
    },
    /** What Google would fire. */
    emit: (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

let map: ReturnType<typeof fakeMap>;

vi.mock('@vis.gl/react-google-maps', () => ({
  useMap: () => map,
}));

const MOSES = 'tech-moses';
const onTheFreeway = { latitude: 29.5516, longitude: -95.1449 };
const furtherUp = { latitude: 29.5541, longitude: -95.1421 };
const property: PropertyPosition = {
  id: 'building-1',
  name: '2914 County Road 8',
  addressLine1: '2914 County Road 8',
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
  vi.stubGlobal('google', {
    maps: {
      LatLngBounds: class {
        extend() {}
      },
      event: { addListenerOnce: vi.fn() },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  map.container.remove();
});

describe('following a technician', () => {
  it('goes to them once when they are picked', () => {
    render(<CameraDirector {...props({ focus: following, followed: onTheFreeway })} />);

    expect(map.panTo).toHaveBeenCalledWith({ lat: 29.5516, lng: -95.1449 });
    expect(map.setZoom).toHaveBeenCalledWith(15);
  });

  it('does not move when their position is merely delivered again', () => {
    // The refetch and every socket frame rebuild the objects; nothing moved.
    const { rerender } = render(
      <CameraDirector {...props({ focus: following, followed: onTheFreeway })} />,
    );
    map.panTo.mockClear();
    map.setZoom.mockClear();

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

    expect(map.panTo).not.toHaveBeenCalled();
    expect(map.setZoom).not.toHaveBeenCalled();
  });

  it('keeps them in the middle as they drive, leaving the zoom alone', () => {
    const { rerender } = render(
      <CameraDirector {...props({ focus: following, followed: onTheFreeway })} />,
    );
    map.setZoom.mockClear();

    rerender(<CameraDirector {...props({ focus: following, followed: furtherUp })} />);

    expect(map.panTo).toHaveBeenLastCalledWith({ lat: 29.5541, lng: -95.1421 });
    expect(map.setZoom).not.toHaveBeenCalled();
  });

  it('stops following the moment the reader moves the map', () => {
    const onReaderMoved = vi.fn();
    const { rerender } = render(
      <CameraDirector {...props({ focus: following, followed: onTheFreeway, onReaderMoved })} />,
    );

    vi.setSystemTime(NOW + 5_000);
    map.emit('dragstart');
    expect(onReaderMoved).toHaveBeenCalled();

    map.panTo.mockClear();
    rerender(
      <CameraDirector
        {...props({ focus: following, followed: furtherUp, onReaderMoved, readerMoved: true })}
      />,
    );
    expect(map.panTo).not.toHaveBeenCalled();
  });

  it('goes back to them, and zooms in again, on Re-center', () => {
    const { rerender } = render(
      <CameraDirector {...props({ focus: following, followed: onTheFreeway, readerMoved: true })} />,
    );
    map.panTo.mockClear();
    map.setZoom.mockClear();

    rerender(
      <CameraDirector
        {...props({ focus: following, followed: furtherUp, readerMoved: false, recenterRequest: 1 })}
      />,
    );

    expect(map.panTo).toHaveBeenCalledWith({ lat: 29.5541, lng: -95.1421 });
    expect(map.setZoom).toHaveBeenCalledWith(15);
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
    expect(map.panTo).not.toHaveBeenCalled();
  });
});

describe('telling the reader’s moves from the map’s own', () => {
  function renderFollowing(onReaderMoved = vi.fn()) {
    render(<CameraDirector {...props({ focus: following, followed: onTheFreeway, onReaderMoved })} />);
    // Past the window in which the fly-to above is still the map's own move.
    vi.setSystemTime(NOW + 5_000);
    return onReaderMoved;
  }

  it('counts a scroll-wheel zoom', () => {
    const onReaderMoved = renderFollowing();

    map.container.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));

    expect(onReaderMoved).toHaveBeenCalledTimes(1);
  });

  it('counts Google’s zoom buttons: a click, then the zoom', () => {
    const onReaderMoved = renderFollowing();
    const zoomIn = document.createElement('button');
    map.container.append(zoomIn);

    zoomIn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    vi.setSystemTime(NOW + 5_200);
    map.emit('zoom_changed');

    expect(onReaderMoved).toHaveBeenCalledTimes(1);
  });

  it('does not count a camera change nobody touched the map for', () => {
    const onReaderMoved = renderFollowing();

    map.emit('zoom_changed');
    map.emit('center_changed');

    expect(onReaderMoved).not.toHaveBeenCalled();
  });

  it('does not count the map’s own pan, even if the reader clicked during it', () => {
    const onReaderMoved = vi.fn();
    render(<CameraDirector {...props({ focus: following, followed: onTheFreeway, onReaderMoved })} />);

    // Within the fly-to's own window.
    map.container.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    map.emit('center_changed');

    expect(onReaderMoved).not.toHaveBeenCalled();
  });

  it('does not count touching this console’s own controls on the map', () => {
    const onReaderMoved = renderFollowing();
    const recenter = document.createElement('button');
    recenter.setAttribute(MAP_OVERLAY_ATTRIBUTE, '');
    map.container.append(recenter);

    recenter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    recenter.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    map.emit('center_changed');

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

    expect(map.panTo).toHaveBeenCalledWith({ lat: 29.53, lng: -95.28 });
    expect(map.setZoom).toHaveBeenCalledWith(18);

    rerender(<CameraDirector {...props({ focus: { ...focus }, properties: [{ ...property }] })} />);

    expect(map.panTo).toHaveBeenCalledTimes(1);
  });
});
