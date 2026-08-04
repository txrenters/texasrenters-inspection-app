import { UNKNOWN_CONNECTIVITY } from '../src/lib/connectivity';

/**
 * When the offline banner shows.
 *
 * Exercised as the predicate rather than through a renderer, matching the
 * convention in the other store tests — the rule is what matters, not React's
 * plumbing.
 */
function bannerVisible(state: { isOnline: boolean; isResolved: boolean }) {
  return state.isResolved && !state.isOnline;
}

describe('offline banner visibility', () => {
  it('stays hidden until NetInfo has reported', () => {
    // The store starts optimistic so the upload queue is not stalled for the
    // seconds before the first event. Trusting that default would flash
    // "offline" on every cold start.
    expect(UNKNOWN_CONNECTIVITY.isOnline).toBe(true);
    expect(bannerVisible({ ...UNKNOWN_CONNECTIVITY, isResolved: false })).toBe(false);
    expect(bannerVisible({ isOnline: false, isResolved: false })).toBe(false);
  });

  it('shows once the device is known to be offline', () => {
    expect(bannerVisible({ isOnline: false, isResolved: true })).toBe(true);
  });

  it('hides again when the connection returns', () => {
    expect(bannerVisible({ isOnline: true, isResolved: true })).toBe(false);
  });
});
