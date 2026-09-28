import { describe, expect, it } from 'vitest';

import { mapboxTokenProblem } from './mapbox-token';

/**
 * The check that was missing when the console's maps went blank.
 *
 * A Mapbox **secret** token was put in `NEXT_PUBLIC_MAPBOX_TOKEN`. Everything
 * downstream looked correct — the workflow passed the value, the Dockerfile
 * declared the build argument in the right stage, Next inlined it, the image
 * built and deployed — and the map drew an empty rectangle. The only way to
 * see it was to pull the token out of the shipped bundle and compare its
 * payload against the one that was meant to be there.
 *
 * Two separate failures, from one wrong value: browsers refuse an `sk.` token,
 * so nothing could draw, and the token was published to every visitor of a
 * public console. Both are worth saying out loud rather than leaving somebody
 * to work out from a blank map a second time.
 */

const PUBLIC = 'pk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbThkeTA4dDEwMTFqIn0.aaaaaaaaaaaaaaaaaaaaaa';
const SECRET = 'sk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbXVsZnQ5M2owNWdiIn0.bbbbbbbbbbbbbbbbbbbbbb';

describe('a Mapbox token', () => {
  it('is fine when it is a public one', () => {
    expect(mapboxTokenProblem(PUBLIC)).toBeNull();
  });

  it('says what is missing when there is none', () => {
    expect(mapboxTokenProblem('')).toContain('NEXT_PUBLIC_MAPBOX_TOKEN');
  });

  /**
   * An unset build argument arrives as the empty string, but a `.env` line with
   * a stray space arrives as whitespace -- which is just as absent and would
   * otherwise pass the check and fail at Mapbox.
   */
  it('counts whitespace as no token at all', () => {
    expect(mapboxTokenProblem('   ')).toContain('NEXT_PUBLIC_MAPBOX_TOKEN');
  });

  it('refuses a secret token, and says it has been published', () => {
    const problem = mapboxTokenProblem(SECRET);

    expect(problem).toContain('secret');
    // Not merely "this will not work". Somebody reading this has already
    // shipped the key, and the thing they need to do is revoke it.
    expect(problem).toContain('revoke');
  });

  it('refuses anything that is not recognisably a token', () => {
    expect(mapboxTokenProblem('your-token-here')).toContain('pk.');
    expect(mapboxTokenProblem('tmp.abc123')).toContain('pk.');
  });
});
