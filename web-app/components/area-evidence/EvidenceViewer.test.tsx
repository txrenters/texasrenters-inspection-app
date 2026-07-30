import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EvidenceViewer, type EvidenceViewerItem } from './EvidenceViewer';

const apiBlob = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiBlob }));

const items: EvidenceViewerItem[] = [
  {
    id: 'photo-1',
    kind: 'photo',
    contentPath: '/api/v1/admin/photos/photo-1/content',
    title: 'Area overview',
    caption: 'Front Porch · Area overview',
  },
  {
    id: 'photo-2',
    kind: 'photo',
    contentPath: '/api/v1/admin/photos/photo-2/content',
    title: 'Finding close-up',
  },
  {
    id: 'rec-1',
    kind: 'recording',
    contentPath: '/api/v1/admin/media/rec-1/content',
    title: 'Primary recording — Foyer',
    posterUrl: 'https://example.test/poster.jpg',
  },
];

beforeEach(() => {
  apiBlob.mockReset();
  apiBlob.mockResolvedValue(new Blob(['x'], { type: 'image/jpeg' }));
  // jsdom implements neither of these.
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  document.body.style.overflow = '';
});

describe('EvidenceViewer', () => {
  it('opens on the item that was clicked, not the first one', async () => {
    render(<EvidenceViewer items={items} startIndex={1} onClose={vi.fn()} />);
    expect(await screen.findByText('Finding close-up')).toBeInTheDocument();
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
  });

  it('fetches through the authenticated client rather than setting a bare src', async () => {
    // Content endpoints require a bearer token; a plain <img src> would 401.
    render(<EvidenceViewer items={items} startIndex={0} onClose={vi.fn()} />);
    await waitFor(() => expect(apiBlob).toHaveBeenCalledWith(items[0]!.contentPath));
  });

  it('moves between evidence with the arrow keys', async () => {
    render(<EvidenceViewer items={items} startIndex={0} onClose={vi.fn()} />);
    await screen.findByText('Area overview');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(await screen.findByText('Finding close-up')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(await screen.findByText('Area overview')).toBeInTheDocument();
  });

  it('wraps at both ends so one key keeps working', async () => {
    render(<EvidenceViewer items={items} startIndex={0} onClose={vi.fn()} />);
    await screen.findByText('Area overview');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    // Backwards from the first lands on the last, rather than doing nothing.
    expect(await screen.findByText('3 / 3')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<EvidenceViewer items={items} startIndex={0} onClose={onClose} />);
    await screen.findByText('Area overview');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders a video element for a recording and an image for a photo', async () => {
    const { container, unmount } = render(
      <EvidenceViewer items={items} startIndex={2} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    unmount();

    const photo = render(<EvidenceViewer items={items} startIndex={0} onClose={vi.fn()} />);
    await waitFor(() => expect(photo.container.querySelector('img')).not.toBeNull());
    expect(photo.container.querySelector('video')).toBeNull();
  });

  it('locks background scroll while open and restores it on close', async () => {
    const { unmount } = render(<EvidenceViewer items={items} startIndex={0} onClose={vi.fn()} />);
    await screen.findByText('Area overview');
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('revokes each object URL when moving on, so a long gallery does not accumulate blobs', async () => {
    render(<EvidenceViewer items={items} startIndex={0} onClose={vi.fn()} />);
    await screen.findByText('Area overview');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock'));
  });

  it('surfaces a failure with a retry instead of an empty frame', async () => {
    apiBlob.mockRejectedValueOnce(new Error('Storage is unavailable.'));
    render(<EvidenceViewer items={items} startIndex={0} onClose={vi.fn()} />);
    expect(await screen.findByText('Storage is unavailable.')).toBeInTheDocument();

    apiBlob.mockResolvedValue(new Blob(['x'], { type: 'image/jpeg' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // Retry must actually re-request; the obvious no-op version re-rendered
    // without refetching and left the error on screen forever.
    await waitFor(() => expect(apiBlob).toHaveBeenCalledTimes(2));
  });

  it('is announced as a modal dialog with its position in the set', async () => {
    render(<EvidenceViewer items={items} startIndex={0} onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal');
    expect(dialog).toHaveAccessibleName('Area overview, 1 of 3');
  });

  it('hides paging affordances when there is only one item', async () => {
    render(<EvidenceViewer items={[items[0]!]} startIndex={0} onClose={vi.fn()} />);
    await screen.findByText('Area overview');
    expect(screen.queryByRole('button', { name: 'Next evidence' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous evidence' })).toBeNull();
  });
});
