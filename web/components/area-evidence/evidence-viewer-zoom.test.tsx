import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EvidenceViewer, type EvidenceViewerItem } from './EvidenceViewer';
import { forgetPhotos } from './photo-cache';

/**
 * Getting close to the damage in a photograph.
 *
 * The zoom lived in a second viewer that only the comparison report used,
 * while the inspection page -- where damage is checked -- had none. The office
 * asked for the mouse wheel there first; these are its tests, now against the
 * one viewer both pages use.
 */

vi.mock('@/lib/api', () => ({
  apiBlob: vi.fn().mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' })),
}));

const photo = (id: string): EvidenceViewerItem => ({
  id,
  kind: 'photo',
  contentPath: `/api/v1/admin/photos/${id}/content`,
  title: 'WINDOWS & LOCKS',
  capturedAt: '2026-09-11T18:00:00.000Z',
});

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:photo', revokeObjectURL: () => {} }),
  );
});

afterEach(() => {
  forgetPhotos();
  vi.unstubAllGlobals();
});

async function open() {
  render(
    <EvidenceViewer
      heading="Living Room · Move-out"
      items={[photo('p1'), photo('p2')]}
      onClose={() => {}}
      startIndex={0}
    />,
  );
  // The photograph arrives asynchronously; zooming acts on the loaded image.
  await screen.findByRole('img');
  return screen.getByTestId('photo-viewport');
}

/** The zoom as the toolbar says it: "Fit" for the whole photograph, a percentage past it. */
const zoomShown = () => screen.getByTestId('zoom-level').textContent;
const percent = () => Number.parseInt(zoomShown() ?? '0', 10);
/**
 * The zoom once the photograph on screen has arrived. The zoom controls are
 * only there while a photograph is, and the next one has not always been
 * fetched ahead by the time a key steps on to it.
 */
const zoomShownOnArrival = async () => {
  await screen.findByRole('img');
  return zoomShown();
};

function wheel(target: HTMLElement, deltaY: number) {
  const event = new WheelEvent('wheel', {
    deltaY,
    clientX: 400,
    clientY: 300,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('zooming with the mouse wheel', () => {
  it('zooms in when the wheel rolls forward, and out again when it rolls back', async () => {
    const viewport = await open();
    expect(zoomShown()).toBe('Fit');

    wheel(viewport, -300);
    const zoomedIn = percent();
    expect(zoomedIn).toBeGreaterThan(100);

    wheel(viewport, 150);
    const zoomedBack = percent();
    expect(zoomedBack).toBeLessThan(zoomedIn);
    expect(zoomedBack).toBeGreaterThan(100);
  });

  it('never goes below the whole photograph, or past the most detailed zoom', async () => {
    const viewport = await open();

    wheel(viewport, 5_000);
    expect(zoomShown()).toBe('Fit');

    wheel(viewport, -50_000);
    expect(zoomShown()).toBe('800%');
  });

  it('keeps the page underneath from scrolling or zooming', async () => {
    const viewport = await open();
    expect(wheel(viewport, -100).defaultPrevented).toBe(true);
  });
});

describe('double-click', () => {
  it('zooms in on the spot, and a second one returns to the whole photograph', async () => {
    const viewport = await open();

    fireEvent.doubleClick(viewport, { clientX: 200, clientY: 150 });
    expect(zoomShown()).toBe('200%');

    fireEvent.doubleClick(viewport, { clientX: 200, clientY: 150 });
    expect(zoomShown()).toBe('Fit');
  });
});

describe('dragging a zoomed photograph', () => {
  it('moves the view the way the pointer moves', async () => {
    const viewport = await open();
    fireEvent.doubleClick(viewport, { clientX: 200, clientY: 150 });
    viewport.scrollLeft = 300;
    viewport.scrollTop = 200;

    fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(viewport, { clientX: 450, clientY: 360, pointerId: 1 });
    fireEvent.pointerUp(viewport, { pointerId: 1 });

    // Dragged left and up by 50 and 40: the photograph follows, so the view
    // scrolls right and down by the same.
    expect(viewport.scrollLeft).toBe(350);
    expect(viewport.scrollTop).toBe(240);
  });

  it('does nothing to a photograph that is not zoomed in', async () => {
    const viewport = await open();
    viewport.scrollTop = 0;

    fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(viewport, { clientX: 450, clientY: 300, pointerId: 1 });

    expect(viewport.scrollTop).toBe(0);
  });
});

describe('the buttons and keys', () => {
  it('step the zoom through the steps the canvas drew', async () => {
    await open();

    const steps = [];
    for (let press = 0; press < 7; press += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      steps.push(zoomShown());
    }
    expect(steps).toEqual(['150%', '200%', '300%', '400%', '600%', '800%', '800%']);
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();

    fireEvent.keyDown(window, { key: '-' });
    expect(zoomShown()).toBe('600%');
    fireEvent.keyDown(window, { key: '0' });
    expect(zoomShown()).toBe('Fit');
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  });

  it('go back to the whole photograph with Fit', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoomShown()).toBe('200%');

    fireEvent.click(screen.getByRole('button', { name: 'Fit the whole photo' }));
    expect(zoomShown()).toBe('Fit');
  });

  it('step on from a zoom the wheel left between two steps', async () => {
    const viewport = await open();
    wheel(viewport, -300);
    expect(percent()).toBeGreaterThan(150);
    expect(percent()).toBeLessThan(200);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoomShown()).toBe('200%');
  });

  it('start every photograph whole', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoomShown()).toBe('150%');

    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(await zoomShownOnArrival()).toBe('Fit');
  });
});

describe('downloading', () => {
  it('saves the original, named for the area, the shot and the Texas day it was taken', async () => {
    const saved: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        saved.push(this.download);
      });
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await vi.waitFor(() => expect(saved).toEqual(['Living Room - Move-out - WINDOWS & LOCKS - 2026-09-11.jpg']));
    click.mockRestore();
  });
});
