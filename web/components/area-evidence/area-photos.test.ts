import type { AreaEvidenceBundle, AreaPhoto } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { areaPhotoItems, fitWithin, nextAreaWithPhotos } from './area-photos';

const area = (id: string, photos: number) => ({
  id,
  counts: { recordings: 0, photos, findings: 0, unreviewedFindings: 0 },
});

describe('the next area with photographs', () => {
  const areas = [area('entrance', 1), area('hallway', 0), area('living', 1), area('kitchen', 3)];

  it('passes over an area with none, in either direction', () => {
    expect(nextAreaWithPhotos(areas, 'entrance', 1)?.id).toBe('living');
    expect(nextAreaWithPhotos(areas, 'living', -1)?.id).toBe('entrance');
  });

  it('is nothing past either end', () => {
    expect(nextAreaWithPhotos(areas, 'kitchen', 1)).toBeNull();
    expect(nextAreaWithPhotos(areas, 'entrance', -1)).toBeNull();
  });

  it('is nothing for an area the list does not hold', () => {
    expect(nextAreaWithPhotos(areas, 'garage', 1)).toBeNull();
  });
});

describe('fitting a photograph to the screen', () => {
  it('fits a portrait photograph by its height, so the box is only as wide as the picture', () => {
    // The Entrance photograph measured on the live console on 2026-10-02: a
    // 1536 × 2048 original in a 988 × 774 stage. The picture was drawn 581 px
    // wide, and the capture time sat on the 988 px box around it.
    expect(fitWithin({ width: 1536, height: 2048 }, { width: 988, height: 774 })).toEqual({
      width: 581,
      height: 774,
    });
  });

  it('never enlarges a photograph past its own size', () => {
    expect(fitWithin({ width: 640, height: 480 }, { width: 1600, height: 900 })).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('waits until both sizes are known', () => {
    expect(fitWithin({ width: 0, height: 0 }, { width: 988, height: 774 })).toBeNull();
    expect(fitWithin({ width: 1536, height: 2048 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe("an area's photographs, in viewing order", () => {
  const photo = (id: string, overrides: Partial<AreaPhoto> = {}): AreaPhoto => ({
    id,
    captureType: 'AREA_OVERVIEW',
    label: null,
    sequenceNumber: 0,
    capturedAt: '2026-10-01T17:51:30.000Z',
    captureTimeSource: 'SERVER_RECEIPT',
    receivedAt: '2026-10-01T17:51:30.000Z',
    sha256: '1e0164960f44aaaabbbb',
    capturedByName: 'Moses Rodriguez',
    contentPath: `/api/v1/admin/photos/${id}/content`,
    ...overrides,
  });
  const bundle = {
    photoGroups: [
      { key: 'OVERVIEW', label: 'Area overview', photos: [photo('overview')] },
      {
        key: 'FINDING',
        label: 'Leak under sink',
        findingId: 'finding-1',
        photos: [photo('close-up', { captureType: 'FINDING_CLOSE_UP', label: 'Under the trap' })],
      },
      {
        key: 'SUPPORTING',
        label: 'Supporting',
        photos: [photo('angle', { captureType: 'SUPPORTING_ANGLE' })],
      },
    ],
  } as unknown as AreaEvidenceBundle;

  it('follows the Photos tab: overview, finding evidence, then supporting', () => {
    expect(areaPhotoItems(bundle).map((item) => item.id)).toEqual(['overview', 'close-up', 'angle']);
  });

  it('titles each by its label, or by what kind of shot it is', () => {
    const [overview, closeUp, angle] = areaPhotoItems(bundle);
    expect(overview.title).toBe('Area overview');
    expect(closeUp.title).toBe('Under the trap');
    expect(angle.title).toBe('Supporting angle');
  });

  it('keeps where the photograph came from in its caption', () => {
    expect(areaPhotoItems(bundle)[0].caption).toBe(
      'Area overview · Received by the server; the capture time is not known · SHA-256 1e0164960f44…',
    );
  });
});
