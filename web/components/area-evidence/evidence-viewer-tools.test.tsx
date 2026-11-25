import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiBlob } from '@/lib/api';

import { EvidenceViewer, type EvidenceViewerItem } from './EvidenceViewer';
import { forgetPhotos } from './photo-cache';

/**
 * The tools the canvas added to the one viewer (approved 2026-11-26): turning
 * a photograph, the strip of the area's photographs, a job photograph's small
 * copy before its original, and a phone's swipe and pinch.
 */

vi.mock('@/lib/api', () => ({
  apiBlob: vi.fn(),
}));

const blob = new Blob(['jpeg'], { type: 'image/jpeg' });

const photo = (id: string, extra: Partial<EvidenceViewerItem> = {}): EvidenceViewerItem => ({
  id,
  kind: 'photo',
  contentPath: `/api/v1/admin/photos/${id}/content`,
  title: `Photo ${id}`,
  ...extra,
});

beforeEach(() => {
  vi.mocked(apiBlob).mockReset().mockResolvedValue(blob);
  let next = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => `blob:${(next += 1)}`, revokeObjectURL: () => {} }),
  );
  // jsdom lays nothing out: a stage of 800 x 600, so a photograph is fitted to something.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  forgetPhotos();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const zoomShown = () => screen.getByTestId('zoom-level').textContent;

/** The photograph on screen, once its pixels are known: 1600 x 1200, landscape. */
async function shownPhoto(width = 1600, height = 1200) {
  const image = await screen.findByRole('img');
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height });
  fireEvent.load(image);
  return image;
}

function open(items: EvidenceViewerItem[], extra: Partial<Parameters<typeof EvidenceViewer>[0]> = {}) {
  return render(<EvidenceViewer items={items} onClose={() => {}} startIndex={0} {...extra} />);
}

describe('turning a photograph', () => {
  it('turns a quarter right and left, and the photo fits its new shape', async () => {
    open([photo('a')]);
    const image = await shownPhoto();
    const frame = screen.getByTestId('photo-frame');
    // Landscape, fitted to 800 x 600.
    expect(frame.style.width).toBe('800px');
    expect(frame.style.height).toBe('600px');

    fireEvent.click(screen.getByRole('button', { name: 'Turn right' }));
    expect(image.style.transform).toContain('rotate(90deg)');
    // Standing up: 450 x 600, the turned photograph's box, with the image itself 600 x 450 inside it.
    expect(frame.style.width).toBe('450px');
    expect(frame.style.height).toBe('600px');
    expect(image.style.width).toBe('600px');
    expect(image.style.height).toBe('450px');

    fireEvent.click(screen.getByRole('button', { name: 'Turn left' }));
    expect(image.style.transform).toContain('rotate(0deg)');
    fireEvent.click(screen.getByRole('button', { name: 'Turn left' }));
    expect(image.style.transform).toContain('rotate(270deg)');
  });

  it('turns with R and Shift+R, and leaves Ctrl+R to the browser', async () => {
    open([photo('a')]);
    const image = await shownPhoto();

    fireEvent.keyDown(window, { key: 'r' });
    expect(image.style.transform).toContain('rotate(90deg)');
    fireEvent.keyDown(window, { key: 'r' });
    expect(image.style.transform).toContain('rotate(180deg)');
    fireEvent.keyDown(window, { key: 'R', shiftKey: true });
    expect(image.style.transform).toContain('rotate(90deg)');
    fireEvent.keyDown(window, { key: 'r', ctrlKey: true });
    expect(image.style.transform).toContain('rotate(90deg)');
  });

  it('keeps a turn on its photograph while the viewer walks on and back, and Fit leaves it', async () => {
    open([photo('a'), photo('b')]);
    const image = await shownPhoto();
    fireEvent.click(screen.getByRole('button', { name: 'Turn right' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit the whole photo' }));
    expect(image.style.transform).toContain('rotate(90deg)');

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    const other = await shownPhoto();
    expect(other.style.transform).toContain('rotate(0deg)');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect((await shownPhoto()).style.transform).toContain('rotate(90deg)');
  });

  it('reports a turn to a caller that holds them, and takes the turns it is given', async () => {
    const onTurn = vi.fn();
    open([photo('a')], { onTurn, turns: { a: 2 } });
    const image = await shownPhoto();
    expect(image.style.transform).toContain('rotate(180deg)');

    fireEvent.click(screen.getByRole('button', { name: 'Turn right' }));
    expect(onTurn).toHaveBeenCalledWith('a', 3);
  });

  it('keeps the capture time upright on the photograph, not turned with it', async () => {
    open([photo('a', { capturedAt: '2026-11-23T15:41:00.000Z', captureTimeSource: 'DEVICE_CLOCK' })]);
    await shownPhoto();
    fireEvent.click(screen.getByRole('button', { name: 'Turn right' }));

    const stamp = screen.getByTestId('photo-stamp');
    expect(stamp.parentElement).toBe(screen.getByTestId('photo-frame'));
    expect(stamp.style.transform).toBe('');
  });
});

describe('the strip of photographs', () => {
  it('shows every one, marks the one on screen, and opens another', async () => {
    open([photo('a'), photo('b'), photo('c')]);
    await shownPhoto();

    const tiles = screen.getAllByRole('button', { name: /of 3: Photo/ });
    expect(tiles).toHaveLength(3);
    expect(tiles[0]).toHaveAttribute('aria-current', 'true');

    fireEvent.click(screen.getByRole('button', { name: '3 of 3: Photo c' }));
    expect(await screen.findByText('Photo c')).toBeTruthy();
    expect(screen.getByRole('button', { name: '3 of 3: Photo c' })).toHaveAttribute('aria-current', 'true');
  });

  it('fetches each thumbnail once, whoever shows it', async () => {
    open([photo('a'), photo('b')]);
    await shownPhoto();
    await vi.waitFor(() =>
      expect(vi.mocked(apiBlob).mock.calls.map(([path]) => path)).toEqual(
        expect.arrayContaining([
          '/api/v1/admin/photos/a/content?w=320',
          '/api/v1/admin/photos/b/content?w=320',
        ]),
      ),
    );
    const thumbnails = vi.mocked(apiBlob).mock.calls.filter(([path]) => String(path).endsWith('?w=320'));
    expect(thumbnails).toHaveLength(2);
  });

  it('is not there for a single photograph', async () => {
    open([photo('a')]);
    await shownPhoto();
    expect(screen.queryByRole('button', { name: /of 1:/ })).toBeNull();
  });
});

describe('a photograph with a smaller copy (a job photograph)', () => {
  const job = photo('f', {
    previewPath: '/api/v1/admin/photos/f/content?w=1600',
    title: 'AC filter change',
    detail: '20x25x1 · upstairs hallway',
    day: '2026-11-23',
  });

  it('opens the 1,600-pixel copy, and fetches the original only past 200%', async () => {
    open([job]);
    await shownPhoto();
    const paths = () => vi.mocked(apiBlob).mock.calls.map(([path]) => path);
    expect(paths()).toContain('/api/v1/admin/photos/f/content?w=1600');
    expect(paths()).not.toContain('/api/v1/admin/photos/f/content');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoomShown()).toBe('200%');
    expect(paths()).not.toContain('/api/v1/admin/photos/f/content');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoomShown()).toBe('300%');
    await vi.waitFor(() => expect(paths()).toContain('/api/v1/admin/photos/f/content'));
  });

  it('says it is getting the full size while the copy stays on screen', async () => {
    let arrive: (value: Blob) => void = () => {};
    open([job]);
    await shownPhoto();
    vi.mocked(apiBlob).mockImplementation(
      (path) => (String(path).endsWith('/content') ? new Promise<Blob>((resolve) => (arrive = resolve)) : Promise.resolve(blob)),
    );
    for (let press = 0; press < 3; press += 1)
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    expect(await screen.findByText('Loading the full-size photo')).toBeTruthy();
    expect(screen.getByRole('img')).toBeTruthy();
    await act(async () => arrive(blob));
    expect(screen.queryByText('Loading the full-size photo')).toBeNull();
  });

  it('reads its title with what it shows, and downloads the original under the property and day', async () => {
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    open([job], { place: '2210 Cedar Bend Dr Unit B' });
    await shownPhoto();
    expect(screen.getByText('AC filter change')).toBeTruthy();
    expect(screen.getAllByText('20x25x1 · upstairs hallway').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await vi.waitFor(() => expect(saved).toEqual(['2210 Cedar Bend Dr Unit B - AC filter change - 2026-11-23.jpg']));
    expect(vi.mocked(apiBlob).mock.calls.map(([path]) => path)).toContain('/api/v1/admin/photos/f/content');
  });
});

describe('a photograph that will not load', () => {
  it('says so, offers Try again, and holds Download until there is a photo', async () => {
    vi.mocked(apiBlob).mockRejectedValueOnce(new Error('HTTP 502'));
    open([photo('a')]);

    expect(await screen.findByText('The photo could not be loaded.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Turn right' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });
});

describe('on a phone', () => {
  it('steps on with a sideways swipe on a photograph that is not zoomed', async () => {
    open([photo('a'), photo('b')]);
    await shownPhoto();
    const viewport = screen.getByTestId('photo-viewport');

    fireEvent.pointerDown(viewport, { button: 0, pointerId: 7, pointerType: 'touch', clientX: 500, clientY: 300 });
    fireEvent.pointerUp(viewport, { pointerId: 7, pointerType: 'touch', clientX: 380, clientY: 310 });

    expect(await screen.findByText('Photo b')).toBeTruthy();
  });

  it('does not step on a short or mostly upward swipe, or a mouse drag', async () => {
    open([photo('a'), photo('b')]);
    await shownPhoto();
    const viewport = screen.getByTestId('photo-viewport');

    fireEvent.pointerDown(viewport, { button: 0, pointerId: 1, pointerType: 'touch', clientX: 500, clientY: 300 });
    fireEvent.pointerUp(viewport, { pointerId: 1, pointerType: 'touch', clientX: 470, clientY: 300 });
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 2, pointerType: 'touch', clientX: 500, clientY: 300 });
    fireEvent.pointerUp(viewport, { pointerId: 2, pointerType: 'touch', clientX: 420, clientY: 140 });
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 3, pointerType: 'mouse', clientX: 500, clientY: 300 });
    fireEvent.pointerUp(viewport, { pointerId: 3, pointerType: 'mouse', clientX: 300, clientY: 300 });

    expect(screen.getByText('Photo a')).toBeTruthy();
  });

  it('zooms with two fingers drawn apart', async () => {
    open([photo('a')]);
    await shownPhoto();
    const viewport = screen.getByTestId('photo-viewport');

    fireEvent.pointerDown(viewport, { button: 0, pointerId: 1, pointerType: 'touch', clientX: 350, clientY: 300 });
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 2, pointerType: 'touch', clientX: 450, clientY: 300 });
    fireEvent.pointerMove(viewport, { pointerId: 2, pointerType: 'touch', clientX: 550, clientY: 300 });

    // A hundred pixels apart, then two hundred: twice the size.
    expect(zoomShown()).toBe('200%');
  });
});
