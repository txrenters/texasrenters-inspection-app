import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LazyPhoto } from './area-evidence/LazyPhoto';
import { PhotoStamp } from './photo-stamp';

/**
 * The capture time on a photograph, in the console.
 *
 * Photographs here are evidence, and the office's own timestamp-camera reports
 * print the time on the picture. The console showed none at all.
 */

vi.mock('@/lib/api', () => ({
  apiBlob: vi.fn().mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' })),
}));

afterEach(cleanup);

describe('the stamp on a photograph', () => {
  it('shows Texas time, to the second, with the zone', () => {
    render(<PhotoStamp capturedAt="2026-09-14T18:22:07.000Z" source="DEVICE_CLOCK" />);
    expect(screen.getByTestId('photo-stamp').textContent).toBe('Sep 14, 2026, 1:22:07 PM CDT');
  });

  it('says when all that is known is when the server received it', () => {
    render(<PhotoStamp capturedAt="2026-09-14T18:22:07.000Z" source="SERVER_RECEIPT" />);
    expect(screen.getByTestId('photo-stamp').textContent).toMatch(/^Received /);
  });

  it('is absent when the time has not been confirmed, rather than wrong', () => {
    // An imported photograph before its report is re-read.
    render(<PhotoStamp capturedAt="2026-09-14T18:22:07.000Z" source={null} />);
    expect(screen.queryByTestId('photo-stamp')).toBeNull();
  });
});

describe('a console thumbnail', () => {
  it('carries the stamp once the photograph has loaded', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:photo', revokeObjectURL: () => {} }));
    render(
      <LazyPhoto
        areaName="Entrance"
        photo={{
          contentPath: '/api/v1/admin/photos/p1/content',
          captureType: 'AREA_OVERVIEW',
          capturedAt: '2026-09-14T18:22:07.000Z',
          captureTimeSource: 'REPORT_STAMP',
        }}
      />,
    );

    expect((await screen.findByTestId('photo-stamp')).textContent).toBe('Sep 14, 2026, 1:22:07 PM CDT');
    vi.unstubAllGlobals();
  });
});
