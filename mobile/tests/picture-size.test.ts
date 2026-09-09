import { TARGET_LONG_EDGE, pickPictureSize } from '../src/media/picture-size';

/**
 * Nothing downscaled a photograph before this. `quality: 0.82` compresses, it
 * does not shrink, so every snapshot was captured at the sensor's full
 * resolution — three to five megabytes, twenty-five to thirty of them per
 * occupied inspection, roughly a hundred megabytes over whatever signal the
 * property has.
 *
 * The rule below is deliberately asymmetric, and that is the part worth
 * pinning: overshooting the target costs upload time, undershooting costs
 * detail in what may be the only evidence behind a charge against a tenant.
 */
describe('what size the camera should capture stills at', () => {
  const ANDROID = ['4032x3024', '3264x2448', '1920x1080', '1280x720', '640x480'];

  it('takes the smallest size that still clears the target', () => {
    // 1920 is closer to 2048 than 3264 is, and is still the wrong answer: it is
    // below the target, and the detail it drops cannot be recovered later.
    expect(pickPictureSize(ANDROID)).toBe('3264x2448');
  });

  it('cuts a twelve-megapixel frame down by roughly four fifths', () => {
    // The whole point of the change, stated as the number it produces.
    const [width = 0, height = 0] = (pickPictureSize(ANDROID) ?? '').split('x').map(Number);
    expect((width * height) / (4032 * 3024)).toBeLessThan(0.7);
  });

  it('accepts a size exactly on the target', () => {
    expect(pickPictureSize(['1280x720', '2048x1536', '4032x3024'])).toBe('2048x1536');
  });

  it('takes the largest available when the device cannot reach the target', () => {
    // An older handset simply cannot do better, and picking anything smaller
    // would throw away detail for nothing.
    expect(pickPictureSize(['640x480', '1280x720'])).toBe('1280x720');
  });

  /**
   * iOS reports capture presets by name, and Android occasionally reports a
   * label this does not recognise. Guessing an ordering for those would be a
   * guess about hardware, and getting it wrong degrades evidence silently — so
   * they are skipped, and an all-preset list leaves the prop unset.
   */
  it('ignores a preset name it cannot read', () => {
    expect(pickPictureSize(['photo', 'high', '3264x2448', 'medium'])).toBe('3264x2448');
  });

  it('answers undefined when nothing is a resolution', () => {
    expect(pickPictureSize(['photo', 'high', 'medium', 'low'])).toBeUndefined();
    expect(pickPictureSize([])).toBeUndefined();
  });

  it('reads a portrait size by its long edge, not its width', () => {
    // A device listing 3024x4032 offers the same frame rotated. Comparing on
    // width alone would reject it and fall back to something smaller.
    expect(pickPictureSize(['1080x1920', '3024x4032'])).toBe('3024x4032');
  });

  it('tolerates spacing and the multiplication sign', () => {
    expect(pickPictureSize(['3264 x 2448'])).toBe('3264 x 2448');
    expect(pickPictureSize(['3264×2448'])).toBe('3264×2448');
  });

  it('rejects a malformed label rather than reading half of it', () => {
    expect(pickPictureSize(['0x0', 'x1080', '1920x'])).toBeUndefined();
  });

  it('is aimed at a size a report can show, not a size a sensor can produce', () => {
    expect(TARGET_LONG_EDGE).toBe(2048);
  });
});
