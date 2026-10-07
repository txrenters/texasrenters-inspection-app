import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { ReportPhotoViewer, type ReportPhotoSlide } from './report-photo-viewer';

/**
 * A report photograph opens over the page, not in a new tab (the maintenance
 * team, 2026-10-08: "same as InspectCloud").
 */

const SLIDES: ReportPhotoSlide[] = [
  { id: 'p1', src: 'https://api.example/photos/p1?w=1000', alt: 'Door', caption: 'Doors and locks', stamp: 'Oct 5, 2026, 5:36:10 PM CDT' },
  { id: 'p2', src: 'https://api.example/photos/p2?w=1000', alt: 'Wall', caption: null, stamp: null },
  { id: 'p3', src: 'https://api.example/photos/p3?w=1000', alt: 'Window', caption: null, stamp: null },
];

function Harness({ start = 0 }: { start?: number | null }) {
  const [index, setIndex] = useState<number | null>(start);
  return (
    <>
      <button onClick={() => setIndex(0)} type="button">
        open
      </button>
      <ReportPhotoViewer
        index={index}
        onClose={() => setIndex(null)}
        onIndexChange={setIndex}
        roomName="Bedroom 1"
        slides={SLIDES}
      />
    </>
  );
}

const shown = () => screen.getByRole('dialog').querySelector('img')!.getAttribute('src');

describe('a photograph on the report', () => {
  it('shows the full-size copy with its room, caption, time and place in the room', () => {
    render(<Harness />);

    expect(shown()).toBe('https://api.example/photos/p1?w=1000');
    expect(screen.getByText('Bedroom 1 · Doors and locks')).toBeInTheDocument();
    expect(screen.getByText('Oct 5, 2026, 5:36:10 PM CDT')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  it('steps through the room with the arrows and the arrow keys, round from the last to the first', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Next photograph' }));
    expect(shown()).toBe('https://api.example/photos/p2?w=1000');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(shown()).toBe('https://api.example/photos/p1?w=1000');
    fireEvent.click(screen.getByRole('button', { name: 'Previous photograph' }));
    expect(shown()).toBe('https://api.example/photos/p3?w=1000');
  });

  it('closes with Escape, and is not there until a photograph is opened', () => {
    render(<Harness start={null} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
