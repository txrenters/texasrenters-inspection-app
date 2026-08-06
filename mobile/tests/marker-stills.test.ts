import { extractMarkerStills, pairMarkers } from '../src/media/marker-stills';

jest.mock('expo-video-thumbnails', () => ({ getThumbnailAsync: jest.fn() }));

const frame = (uri: string) => ({ uri, width: 1920, height: 1080 });

describe('extracting the moments a technician marked', () => {
  it('cuts one still per marker at the recorded offset', async () => {
    // Android cannot photograph during a video, so the shutter records an
    // offset and this turns it into the picture the technician meant to take.
    const extract = jest.fn().mockImplementation((_uri, options: { time: number }) =>
      Promise.resolve(frame(`file:///still-${options.time}.jpg`)),
    );
    const result = await extractMarkerStills(
      'file:///walkthrough.mp4',
      [
        { videoTimestampMs: 4200, captureType: 'FINDING_CONTEXT' },
        { videoTimestampMs: 19800, captureType: 'FINDING_CLOSE_UP' },
      ],
      extract,
    );

    expect(result.stills.map((still) => still.videoTimestampMs)).toEqual([4200, 19800]);
    expect(result.stills[0]!.uri).toBe('file:///still-4200.jpg');
    // Milliseconds throughout — the same unit the shutter recorded, so no
    // conversion can drift.
    expect(extract.mock.calls[0][1].time).toBe(4200);
  });

  it('keeps the capture type chosen at the moment of marking', async () => {
    const extract = jest.fn().mockResolvedValue(frame('file:///a.jpg'));
    const result = await extractMarkerStills(
      'file:///w.mp4',
      [{ videoTimestampMs: 1000, captureType: 'AREA_OVERVIEW' }],
      extract,
    );
    expect(result.stills[0]!.captureType).toBe('AREA_OVERVIEW');
  });

  it('loses one frame rather than the whole walkthrough', async () => {
    // Abandoning the rest — or failing the upload of a finished recording —
    // would cost far more than one undecodable frame.
    const extract = jest
      .fn()
      .mockResolvedValueOnce(frame('file:///ok.jpg'))
      .mockRejectedValueOnce(new Error('could not decode frame'))
      .mockResolvedValueOnce(frame('file:///ok2.jpg'));

    const result = await extractMarkerStills(
      'file:///w.mp4',
      [
        { videoTimestampMs: 1, captureType: 'FINDING_CONTEXT' },
        { videoTimestampMs: 2, captureType: 'FINDING_CONTEXT' },
        { videoTimestampMs: 3, captureType: 'FINDING_CONTEXT' },
      ],
      extract,
    );
    expect(result.stills).toHaveLength(2);
    // Reported, not swallowed: the technician is told what was missed.
    expect(result.failures).toEqual([
      { videoTimestampMs: 2, reason: 'could not decode frame' },
    ]);
  });

  it('extracts one at a time', async () => {
    // Each extraction decodes video; a dozen at once on a mid-range phone
    // competes with the upload already in flight.
    let concurrent = 0;
    let peak = 0;
    const extract = jest.fn().mockImplementation(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return frame('file:///a.jpg');
    });

    await extractMarkerStills(
      'file:///w.mp4',
      Array.from({ length: 5 }, (_, index) => ({
        videoTimestampMs: index * 1000,
        captureType: 'FINDING_CONTEXT' as const,
      })),
      extract,
    );
    expect(peak).toBe(1);
  });

  it('does nothing when the technician marked nothing', async () => {
    const extract = jest.fn();
    const result = await extractMarkerStills('file:///w.mp4', [], extract);
    expect(result).toEqual({ stills: [], failures: [] });
    expect(extract).not.toHaveBeenCalled();
  });
});

describe('pairing offsets with capture types', () => {
  it('matches them by the order they were tapped', () => {
    expect(pairMarkers([100, 200], ['AREA_OVERVIEW', 'FINDING_CLOSE_UP'])).toEqual([
      { videoTimestampMs: 100, captureType: 'AREA_OVERVIEW' },
      { videoTimestampMs: 200, captureType: 'FINDING_CLOSE_UP' },
    ]);
  });

  it('keeps a frame whose label went missing', () => {
    // A mismatch means one array lost an entry. Discarding evidence over a
    // label would be the wrong trade.
    expect(pairMarkers([100, 200], ['AREA_OVERVIEW'])).toEqual([
      { videoTimestampMs: 100, captureType: 'AREA_OVERVIEW' },
      { videoTimestampMs: 200, captureType: 'FINDING_CONTEXT' },
    ]);
  });
});
