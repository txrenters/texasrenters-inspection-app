import {
  DEACTIVATION_SHARE_FLOOR,
  MAX_DEACTIVATION_SHARE,
  deactivationRefusal,
} from '../src/workers/propertyware-sync/propertyware-sync.store';

/**
 * The one thing in the sync that can take a property out of the application.
 *
 * `deactivateUnseen` marks everything a reconciliation fetch did not return as
 * no longer managed. That is only sound when the fetch is known to be
 * *complete* — and a sync is precisely where it might not be. Propertyware has
 * returned zero records for buildings three times in this account's history;
 * all three landed on incremental runs, where the sweep does not run. Nothing
 * about that was by design, and on a reconciliation run the same empty fetch
 * would have deactivated all 574 buildings in one pass.
 *
 * Refusing is always the safe answer. A property left active for one more day
 * surfaces in a queue; a property wrongly deactivated disappears from the app
 * and is not brought back by the next run, because a row nobody fetches is a
 * row nobody reactivates.
 */

describe('when a reconciliation sweep must refuse', () => {
  it('refuses when the fetch returned nothing at all', () => {
    // The live hazard. An empty page, a scope change, an expired credential —
    // never a legitimate "every property left management overnight".
    expect(deactivationRefusal(0, 574, 574)).toBe('NOTHING_SEEN');
  });

  it('refuses even when nothing would be deactivated by it', () => {
    // Belt and braces: an empty fetch is wrong regardless of what it implies,
    // and treating it as valid on a small dataset would leave the rule
    // depending on how many rows happened to exist.
    expect(deactivationRefusal(0, 0, 0)).toBe('NOTHING_SEEN');
  });

  it('refuses a sweep proposing more churn than a month could produce', () => {
    // 574 active, 200 about to go. Real churn here is one property in three
    // weeks; this describes a half-failed fetch.
    expect(deactivationRefusal(374, 200, 574)).toBe('TOO_MANY');
  });

  it('allows ordinary churn', () => {
    // One property genuinely leaving management, which is what the live
    // history actually contains.
    expect(deactivationRefusal(573, 1, 574)).toBeUndefined();
  });

  it('allows a large sweep that is still a small share', () => {
    // Deliberately not a blanket cap on the count: offboarding a portfolio is a
    // real thing, and 50 of 574 is under a fifth.
    expect(deactivationRefusal(524, 50, 574)).toBeUndefined();
  });
});

describe('the share floor', () => {
  it('steps aside when there is no portfolio to take a share of', () => {
    // Two of five leaving is 40%, and entirely believable. The proportion only
    // carries information once the denominator is meaningful.
    expect(deactivationRefusal(3, 2, 5)).toBeUndefined();
  });

  it('starts applying once past the floor', () => {
    // Just above the floor, and well over the share: this is the first size at
    // which the proportion is worth listening to.
    const past = DEACTIVATION_SHARE_FLOOR + 1;
    expect(deactivationRefusal(1, past, past + 1)).toBe('TOO_MANY');
  });

  it('is the share, not the count, that decides above the floor', () => {
    // The same absolute number is fine in a large portfolio and wrong in a
    // small one, which is the whole reason this is a proportion.
    expect(deactivationRefusal(994, 6, 1_000)).toBeUndefined();
    expect(deactivationRefusal(4, 6, 10)).toBe('TOO_MANY');
  });
});

describe('the threshold itself', () => {
  it('sits where a fifth of the portfolio would go', () => {
    // Pinned so a later loosening is a deliberate decision rather than a typo.
    expect(MAX_DEACTIVATION_SHARE).toBe(0.2);
    expect(DEACTIVATION_SHARE_FLOOR).toBe(5);
  });

  it('is exclusive, so exactly the threshold still runs', () => {
    // 20 of 100 is exactly a fifth and is allowed; 21 is not. Stated because
    // "more than a fifth" and "at least a fifth" differ by one property.
    expect(deactivationRefusal(80, 20, 100)).toBeUndefined();
    expect(deactivationRefusal(79, 21, 100)).toBe('TOO_MANY');
  });
});
