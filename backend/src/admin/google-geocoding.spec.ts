import {
  parseGoogleResponse,
  precisionFromLocationType,
} from './google-geocoding.client';

/**
 * Why a second geocoder exists at all.
 *
 * The Census service interpolates along a street segment: it takes the block's
 * house-number range and picks a proportional point on the road. Measured
 * against Google on four live properties it was 18, 18, 61 and 75 metres from
 * the roof. Seventy-five metres on a suburban street is several houses down --
 * the difference between a technician parking outside the inspection and
 * outside a stranger's home.
 */

const ok = (over: Record<string, unknown> = {}) => ({
  status: 'OK',
  results: [
    {
      formatted_address: '9656 Knight Rd, Houston, TX 77045, USA',
      geometry: {
        location: { lat: 29.665898, lng: -95.399864 },
        location_type: 'ROOFTOP',
      },
      ...over,
    },
  ],
});

describe('reading a Google geocode', () => {
  it('takes the roof', () => {
    expect(parseGoogleResponse(ok())).toEqual({
      latitude: 29.665898,
      longitude: -95.399864,
      precision: 'ROOFTOP',
      matchedAddress: '9656 Knight Rd, Houston, TX 77045, USA',
    });
  });

  it('refuses a response that is not OK, however well formed', () => {
    /**
     * The trap. Google answers HTTP 200 for every outcome including refusal,
     * so checking `response.ok` alone reads `REQUEST_DENIED` as a successful
     * geocode of nothing -- and an expired key would silently become "no
     * address ever matches".
     */
    expect(parseGoogleResponse({ status: 'REQUEST_DENIED', results: [] })).toBeNull();
    expect(parseGoogleResponse({ status: 'ZERO_RESULTS', results: [] })).toBeNull();
    expect(parseGoogleResponse({ status: 'OVER_QUERY_LIMIT', results: [] })).toBeNull();
  });

  it('refuses null island', () => {
    // 0,0 is in the Atlantic and is what a geocoder returns when it has
    // nothing. No US address is within a thousand miles of it.
    const body = ok({ geometry: { location: { lat: 0, lng: 0 }, location_type: 'ROOFTOP' } });
    expect(parseGoogleResponse(body)).toBeNull();
  });

  it.each([
    [{ lat: 'north', lng: -95 }],
    [{ lat: 91, lng: -95 }],
    [{ lat: 29, lng: -181 }],
    [{}],
  ])('refuses a coordinate that is not one: %p', (location) => {
    expect(
      parseGoogleResponse(ok({ geometry: { location, location_type: 'ROOFTOP' } })),
    ).toBeNull();
  });

  it('survives a shape it has never seen', () => {
    expect(parseGoogleResponse(null)).toBeNull();
    expect(parseGoogleResponse({})).toBeNull();
    expect(parseGoogleResponse({ status: 'OK' })).toBeNull();
    expect(parseGoogleResponse({ status: 'OK', results: [] })).toBeNull();
  });

  it('keeps a missing formatted address as null rather than inventing one', () => {
    const body = ok({ formatted_address: undefined });
    expect(parseGoogleResponse(body)?.matchedAddress).toBeNull();
  });
});

describe('how precise Google says it was', () => {
  it('is a roof only when Google says roof', () => {
    expect(precisionFromLocationType('ROOFTOP')).toBe('ROOFTOP');
  });

  it('treats a street-segment answer as interpolated, like the Census one', () => {
    // `GEOMETRIC_CENTER` is the middle of a segment or polyline, which is the
    // same kind of claim -- so it maps to the same value rather than inventing
    // a fourth level of precision.
    expect(precisionFromLocationType('RANGE_INTERPOLATED')).toBe('INTERPOLATED');
    expect(precisionFromLocationType('GEOMETRIC_CENTER')).toBe('INTERPOLATED');
  });

  it('treats a city-level answer as a centroid, which is not drawable', () => {
    /**
     * `APPROXIMATE` is a postcode or a city. `TRUSTWORTHY_PRECISIONS` excludes
     * CENTROID, so mapping it here is what keeps a pin off the middle of
     * Houston labelled as somebody's house.
     */
    expect(precisionFromLocationType('APPROXIMATE')).toBe('CENTROID');
  });

  it('is a centroid for anything it does not recognise', () => {
    // Unknown means untrusted, not "probably fine".
    expect(precisionFromLocationType('SOMETHING_NEW')).toBe('CENTROID');
    expect(precisionFromLocationType(undefined)).toBe('CENTROID');
  });
});
