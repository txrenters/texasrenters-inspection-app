import { parseCensusResponse } from './property-geocoding.service';

/**
 * A real Census reply, trimmed to the fields that are read.
 *
 * `x` is longitude and `y` is latitude — the single most important thing about
 * this format, and the reason these tests exist at all.
 */
const HOUSTON_REPLY = {
  result: {
    addressMatches: [
      {
        matchedAddress: '10054 COPPER HOLLOW LN, HOUSTON, TX, 77044',
        coordinates: { x: -95.18234, y: 29.87451 },
      },
    ],
  },
};

describe('parseCensusResponse', () => {
  it('reads x as longitude and y as latitude', () => {
    // Swapping these puts every Texas property in the Indian Ocean, and the
    // mistake is invisible until somebody opens the map.
    expect(parseCensusResponse(HOUSTON_REPLY)).toEqual({
      latitude: 29.87451,
      longitude: -95.18234,
      precision: 'INTERPOLATED',
      matchedAddress: '10054 COPPER HOLLOW LN, HOUSTON, TX, 77044',
    });
  });

  it('never claims rooftop precision', () => {
    // Census interpolates along a street segment. Recording that as ROOFTOP
    // would have the console draw a guess as though it were a survey.
    expect(parseCensusResponse(HOUSTON_REPLY)?.precision).toBe('INTERPOLATED');
  });

  it('returns null when the address matched nothing', () => {
    expect(parseCensusResponse({ result: { addressMatches: [] } })).toBeNull();
  });

  it('rejects the null island', () => {
    // 0,0 is in the Atlantic and is what a geocoder returns when it has
    // nothing. No US address is within a thousand miles of it.
    expect(
      parseCensusResponse({ result: { addressMatches: [{ coordinates: { x: 0, y: 0 } }] } }),
    ).toBeNull();
  });

  it('rejects coordinates outside the possible range', () => {
    expect(
      parseCensusResponse({ result: { addressMatches: [{ coordinates: { x: -95.1, y: 214 } }] } }),
    ).toBeNull();
  });

  it('survives a response shaped like nothing in particular', () => {
    // The service must not throw on a maintenance page or an HTML error body
    // served with a JSON content type.
    for (const body of [null, undefined, {}, { result: {} }, 'not json', { result: { addressMatches: 'x' } }])
      expect(parseCensusResponse(body)).toBeNull();
  });

  it('tolerates a match with no coordinates at all', () => {
    expect(parseCensusResponse({ result: { addressMatches: [{ matchedAddress: 'x' }] } })).toBeNull();
  });
});
