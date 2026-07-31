import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { readFrameMarkers } from '../src/technician/media-processing.service';
import { TechnicianMediaUploadDto } from '../src/technician/technician.dto';

function upload(overrides: Record<string, unknown>) {
  return plainToInstance(TechnicianMediaUploadDto, {
    idempotencyKey: 'abcdefgh1234',
    durationSeconds: 60,
    ...overrides,
  });
}

describe('frame markers from a multipart upload', () => {
  it('parses the comma-separated list a multipart field delivers', () => {
    const dto = upload({ frameMarkersMs: '1200,4500,9800' });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.frameMarkersMs).toEqual([1200, 4500, 9800]);
  });

  it('sorts, de-duplicates and drops unparseable entries', () => {
    // A bad marker must not fail an upload that carries the actual room video.
    const dto = upload({ frameMarkersMs: '9800,1200,1200,,abc,-5,4500' });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.frameMarkersMs).toEqual([1200, 4500, 9800]);
  });

  it('accepts an upload with no markers at all', () => {
    const dto = upload({});
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.frameMarkersMs).toBeUndefined();
  });

  it('caps how many frames one recording can ask the server to cut', () => {
    const many = Array.from({ length: 200 }, (_, index) => index * 100).join(',');
    const dto = upload({ frameMarkersMs: many });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.frameMarkersMs).toHaveLength(60);
  });
});

describe('readFrameMarkers', () => {
  it('ignores offsets past the end of the recording', () => {
    // The client controls these numbers; a marker beyond the video would spawn
    // an ffmpeg pass that can only fail.
    expect(readFrameMarkers({ frameMarkersMs: [1000, 59_000, 90_000] }, 60)).toEqual([
      1000, 59_000,
    ]);
  });

  it('returns nothing for a summary without markers', () => {
    expect(readFrameMarkers({ snapshotCount: 2 }, 60)).toEqual([]);
    expect(readFrameMarkers(null, 60)).toEqual([]);
    expect(readFrameMarkers({ frameMarkersMs: 'not-an-array' }, 60)).toEqual([]);
  });

  it('drops non-numeric and negative entries rather than trusting them', () => {
    expect(
      readFrameMarkers({ frameMarkersMs: [1000, '2000', -1, Number.NaN, 3000] }, 60),
    ).toEqual([1000, 3000]);
  });

  it('sorts and de-duplicates so frames come out in recording order', () => {
    expect(readFrameMarkers({ frameMarkersMs: [5000, 1000, 5000, 3000] }, 60)).toEqual([
      1000, 3000, 5000,
    ]);
  });
});
