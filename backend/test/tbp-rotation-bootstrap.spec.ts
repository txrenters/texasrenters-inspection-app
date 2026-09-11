import {
  type BootstrapResolution,
  type BootstrapVisit,
  isUtcTimestamp,
  rankBootstrapVisits,
} from '../src/planning/tbp-plan.service';

const visit = (startAt: string, street1: string): BootstrapVisit => ({
  startAt,
  street1,
  street2: null,
  postalCode: '77002',
});

/** Resolves a visit by street name, so a test reads like the data does. */
const byStreet =
  (mapping: Record<string, BootstrapResolution>) =>
  (candidate: BootstrapVisit): BootstrapResolution =>
    mapping[candidate.street1 ?? ''] ?? 'NO_ADDRESS_MATCH';

describe('ordering a quarter safely', () => {
  /**
   * The bootstrap sorts on the raw timestamp string in SQL, which is only
   * chronological when every value shares an offset. Every `startAt` in the
   * live table ends in `Z` — 112 of them, checked — but a feed that started
   * mixing offsets would interleave the quarter while looking entirely normal.
   */
  it('accepts a UTC timestamp', () => {
    expect(isUtcTimestamp('2026-08-26T05:00:00Z')).toBe(true);
  });

  it('rejects an offset timestamp, which text ordering would interleave', () => {
    expect(isUtcTimestamp('2026-08-26T00:00:00-05:00')).toBe(false);
  });

  it('rejects a missing timestamp rather than treating it as the epoch', () => {
    expect(isUtcTimestamp(null)).toBe(false);
    expect(isUtcTimestamp(undefined)).toBe(false);
  });
});

describe('recovering last quarter’s order from Jobber visits', () => {
  it('numbers the visits in the order they were run', () => {
    const { ranks } = rankBootstrapVisits(
      [
        visit('2026-07-02T05:00:00Z', 'first ave'),
        visit('2026-08-11T05:00:00Z', 'second st'),
        visit('2026-09-30T05:00:00Z', 'third rd'),
      ],
      byStreet({ 'first ave': 't-1', 'second st': 't-2', 'third rd': 't-3' }),
    );

    expect(ranks).toEqual([
      { tenantExternalId: 't-1', sequence: 1 },
      { tenantExternalId: 't-2', sequence: 2 },
      { tenantExternalId: 't-3', sequence: 3 },
    ]);
  });

  /**
   * Densified, not sparse. A visit that could not be resolved must not leave a
   * hole in the numbering — the sequence is a queue position, and a gap would
   * be read as a place somebody should have been.
   */
  it('closes over a visit it could not resolve', () => {
    const { ranks, unmatchedAddress } = rankBootstrapVisits(
      [
        visit('2026-07-02T05:00:00Z', 'first ave'),
        visit('2026-08-11T05:00:00Z', 'nowhere blvd'),
        visit('2026-09-30T05:00:00Z', 'third rd'),
      ],
      byStreet({ 'first ave': 't-1', 'third rd': 't-3' }),
    );

    expect(ranks).toEqual([
      { tenantExternalId: 't-1', sequence: 1 },
      { tenantExternalId: 't-3', sequence: 2 },
    ]);
    expect(unmatchedAddress).toBe(1);
  });

  /**
   * A visit carries an address, not a lease, so a building holding two enrolled
   * tenancies is a question this cannot answer. Counted apart from an unmatched
   * address because the two need different fixes: one is a mapping gap, the
   * other is genuinely ambiguous data.
   */
  it('refuses to guess which tenancy a shared building’s visit was for', () => {
    const { ranks, ambiguousBuilding, unmatchedAddress } = rankBootstrapVisits(
      [visit('2026-07-02T05:00:00Z', 'duplex dr')],
      byStreet({ 'duplex dr': 'AMBIGUOUS_BUILDING' }),
    );

    expect(ranks).toEqual([]);
    expect(ambiguousBuilding).toBe(1);
    expect(unmatchedAddress).toBe(0);
  });

  /**
   * A property visited twice in a quarter keeps its first position: the second
   * visit is a repeat of the same work, not a later place in the queue. Without
   * this the tenancy would hold two positions and push everyone below it down.
   */
  it('keeps the first position when a property was visited twice', () => {
    const { ranks } = rankBootstrapVisits(
      [
        visit('2026-07-02T05:00:00Z', 'first ave'),
        visit('2026-08-11T05:00:00Z', 'second st'),
        visit('2026-09-30T05:00:00Z', 'first ave'),
      ],
      byStreet({ 'first ave': 't-1', 'second st': 't-2' }),
    );

    expect(ranks).toEqual([
      { tenantExternalId: 't-1', sequence: 1 },
      { tenantExternalId: 't-2', sequence: 2 },
    ]);
  });

  it('returns nothing when no visit resolves, rather than an empty rotation', () => {
    const { ranks, unmatchedAddress } = rankBootstrapVisits(
      [visit('2026-07-02T05:00:00Z', 'nowhere blvd')],
      byStreet({}),
    );

    expect(ranks).toEqual([]);
    expect(unmatchedAddress).toBe(1);
  });
});
