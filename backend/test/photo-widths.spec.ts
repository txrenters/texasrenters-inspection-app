import { ALLOWED_PHOTO_WIDTHS, isAllowedPhotoWidth } from '../src/common/image-resizing';

/**
 * The widths a shared report may ask a photograph at. Each is cached as its own
 * stored object, from an endpoint anyone with the link can call, so the list is
 * closed: an open integer would let anyone fill the bucket with variants.
 */
describe('photo widths a report may ask for', () => {
  it('serves the thumbnail, the sharp thumbnail of a three-a-row grid, and the full view', () => {
    expect(ALLOWED_PHOTO_WIDTHS).toEqual([320, 640, 1000]);
    for (const width of [320, 640, 1000]) expect(isAllowedPhotoWidth(width)).toBe(true);
  });

  it('refuses any other width', () => {
    for (const width of [0, 319, 500, 641, 1200, 4000]) expect(isAllowedPhotoWidth(width)).toBe(false);
  });
});
