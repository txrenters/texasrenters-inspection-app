import type { PublicReportPhoto } from '@texasrenters/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PhotoLightbox } from './photo-lightbox';

/**
 * Getting close to the damage in a comparison photograph.
 *
 * The viewer only zoomed from its buttons, in half steps, and always about the
 * top of the photograph -- so reading a crack in a window frame meant clicking
 * repeatedly and then scrolling to find it again. The office asked for the
 * mouse wheel.
 */

vi.mock('@/lib/api', () => ({
  apiBlob: vi.fn().mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' })),
}));

const photo = (id: string): PublicReportPhoto => ({
  id,
  roomId: 'area-1',
  label: 'WINDOWS & LOCKS',
  capturedAt: '2026-09-11T18:00:00.000Z',
  contentPath: `/api/v1/admin/photos/${id}/content`,
});

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:photo', revokeObjectURL: () => {} }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open() {
  render(
    <PhotoLightbox areaName="Living Room" index={0} onClose={() => {}} photos={[photo('p1'), photo('p2')]} sideLabel="move-out" />,
  );
  // The photograph arrives asynchronously; zooming acts on the loaded image.
  await screen.findByRole('img');
  return screen.getByTestId('photo-viewport');
}

const zoomShown = () => screen.getByText(/%$/).textContent;

function wheel(target: HTMLElement, deltaY: number) {
  const event = new WheelEvent('wheel', { deltaY, clientX: 400, clientY: 300, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('zooming with the mouse wheel', () => {
  it('zooms in when the wheel rolls forward, and out again when it rolls back', async () => {
    const viewport = await open();
    expect(zoomShown()).toBe('100%');

    wheel(viewport, -300);
    const zoomedIn = Number.parseInt(zoomShown() ?? '0', 10);
    expect(zoomedIn).toBeGreaterThan(100);

    wheel(viewport, 150);
    const zoomedBack = Number.parseInt(zoomShown() ?? '0', 10);
    expect(zoomedBack).toBeLessThan(zoomedIn);
    expect(zoomedBack).toBeGreaterThanOrEqual(100);
  });

  it('never goes below the whole photograph, or past the most detailed zoom', async () => {
    const viewport = await open();

    wheel(viewport, 5_000);
    expect(zoomShown()).toBe('100%');

    wheel(viewport, -50_000);
    expect(zoomShown()).toBe('600%');
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
    expect(zoomShown()).toBe('250%');

    fireEvent.doubleClick(viewport, { clientX: 200, clientY: 150 });
    expect(zoomShown()).toBe('100%');
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

describe('the buttons and keys it already had', () => {
  it('still step the zoom', async () => {
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoomShown()).toBe('150%');
    fireEvent.keyDown(document, { key: '0' });
    expect(zoomShown()).toBe('100%');
  });
});
