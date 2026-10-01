import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cachedPhoto, forgetPhotos, loadPhoto } from './photo-cache';

/**
 * Photographs the viewer has shown, kept for a moment.
 *
 * The API answers `no-store`, and the viewer used to discard each photograph
 * as it moved on, so going back to one cost another two seconds from the
 * office. Bounded, because these are originals.
 */

const apiBlob = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiBlob }));

let made = 0;
const revoked: string[] = [];

beforeEach(() => {
  made = 0;
  revoked.length = 0;
  apiBlob.mockReset();
  apiBlob.mockImplementation(async () => new Blob(['jpeg'], { type: 'image/jpeg' }));
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: () => `blob:${++made}`,
      revokeObjectURL: (url: string) => {
        revoked.push(url);
      },
    }),
  );
});

afterEach(() => {
  forgetPhotos();
  vi.unstubAllGlobals();
});

const path = (n: number) => `/api/v1/admin/photos/p${n}/content`;

describe('the photo cache', () => {
  it('fetches a photograph once, however many ask for it', async () => {
    const [first, second] = await Promise.all([loadPhoto(path(1)), loadPhoto(path(1))]);

    expect(apiBlob).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(cachedPhoto(path(1))).toBe(first);
  });

  it('has nothing to show before a photograph arrives', () => {
    void loadPhoto(path(1));
    expect(cachedPhoto(path(1))).toBeNull();
  });

  it('asks again after a failure rather than replaying it', async () => {
    apiBlob.mockRejectedValueOnce(new Error('The API could not be reached.'));

    await expect(loadPhoto(path(2))).rejects.toThrow('could not be reached');
    await loadPhoto(path(2));

    expect(apiBlob).toHaveBeenCalledTimes(2);
    expect(cachedPhoto(path(2))).not.toBeNull();
  });

  it('keeps a dozen, releasing the one used longest ago', async () => {
    for (let n = 1; n <= 12; n += 1) await loadPhoto(path(n));
    // Looked at again, so the oldest is now the second.
    await loadPhoto(path(1));
    await loadPhoto(path(13));

    expect(cachedPhoto(path(1))).not.toBeNull();
    expect(cachedPhoto(path(2))).toBeNull();
    expect(revoked).toEqual(['blob:2']);
    expect(cachedPhoto(path(13))).not.toBeNull();
  });
});
