import { downscaleForUpload } from '../src/media/downscale';
import { TARGET_LONG_EDGE } from '../src/media/picture-size';

/**
 * Photographs were going up at whatever size the device produced.
 *
 * `pictureSize` caps the capture, and on Android it does. On iOS the offered
 * sizes come back as preset *names* — "photo", "high" — which carry no
 * resolution, so nothing parses, the prop is left unset, and every iPhone
 * photograph is taken at the sensor's full resolution. The gallery import
 * never went near that cap at all.
 *
 * Measured on production 2026-09-22: camera photographs averaging 1.83 MB and
 * reaching 3840 pixels wide, gallery imports averaging **6.38 MB**, and single
 * photograph uploads taking 20, 37 and 82 seconds — which is what made a
 * technician's submit appear to hang for ten.
 */

const mockRendered = { uri: 'file:///small.jpg', width: 2048, height: 1536 };
const mockResize = jest.fn();
const mockSave = jest.fn();

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: {
    manipulate: (uri: string) => ({
      resize: (size: { width: number; height: number }) => {
        mockResize({ uri, ...size });
        return { renderAsync: async () => ({ saveAsync: mockSave }) };
      },
    }),
  },
}));

beforeEach(() => {
  mockResize.mockClear();
  mockSave.mockReset().mockResolvedValue(mockRendered);
});

describe('bringing a photograph down for upload', () => {
  it('resizes one larger than the target, keeping its shape', async () => {
    // 4032x3024 is a current iPhone's full frame — the uncapped iOS case.
    const result = await downscaleForUpload({ uri: 'file:///big.jpg', width: 4032, height: 3024 });

    expect(mockResize).toHaveBeenCalledWith({ uri: 'file:///big.jpg', width: 2048, height: 1536 });
    expect(result).toEqual(mockRendered);
  });

  /** Re-encoding a photograph already small enough costs time and detail for nothing. */
  it('leaves one already at or below the target alone', async () => {
    const small = { uri: 'file:///small.jpg', width: 1600, height: 1200 };

    await expect(downscaleForUpload(small)).resolves.toBe(small);
    expect(mockResize).not.toHaveBeenCalled();
  });

  it('leaves one exactly at the target alone', async () => {
    const exact = { uri: 'file:///exact.jpg', width: TARGET_LONG_EDGE, height: 1000 };

    await expect(downscaleForUpload(exact)).resolves.toBe(exact);
    expect(mockResize).not.toHaveBeenCalled();
  });

  /** A portrait screenshot: the long edge is the height, and that is what is capped. */
  it('measures the long edge, whichever way up the photograph is', async () => {
    await downscaleForUpload({ uri: 'file:///tall.png', width: 1170, height: 2532 });

    expect(mockResize).toHaveBeenCalledWith({ uri: 'file:///tall.png', width: 946, height: 2048 });
  });

  /** Dimensions nobody reported cannot be compared, so nothing is attempted. */
  it('leaves one whose size is unknown alone', async () => {
    const unknown = { uri: 'file:///unknown.jpg', width: 0, height: 0 };

    await expect(downscaleForUpload(unknown)).resolves.toBe(unknown);
    expect(mockResize).not.toHaveBeenCalled();
  });

  /**
   * A photograph larger than we would like is still evidence; one a resize
   * threw away is gone, and a technician in somebody's kitchen cannot take it
   * again.
   */
  it('gives back the original when the resize fails', async () => {
    mockSave.mockRejectedValue(new Error('out of memory'));
    const big = { uri: 'file:///big.jpg', width: 4032, height: 3024 };

    await expect(downscaleForUpload(big)).resolves.toBe(big);
  });
});
