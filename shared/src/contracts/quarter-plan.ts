/**
 * Quarter arithmetic, and the rule that decides who gets inspected first.
 *
 * Pure and dependency-free on purpose. The ordering below is the single thing
 * a tenant actually experiences about this feature — it decides whether their
 * visit lands in October or December — and it needs to be testable without a
 * database, a clock, or a Propertyware report.
 *
 * Everything here works in UTC. `Inspection.scheduledAt` is a `DATE` column and
 * a quarter boundary is a calendar fact, so a local-time reading would move
 * both by a day for anyone east of Greenwich — and the office is often in
 * Manila, thirteen hours ahead.
 */

export type QuarterNumber = 1 | 2 | 3 | 4;

export interface Quarter {
  year: number;
  quarter: QuarterNumber;
}

/** How far ahead of a quarter the plan is built. */
export const DEFAULT_PLANNING_LEAD_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function quarterOf(date: Date): Quarter {
  return {
    year: date.getUTCFullYear(),
    quarter: ((Math.floor(date.getUTCMonth() / 3) + 1) as QuarterNumber),
  };
}

/** Midnight UTC on the quarter's first day. */
export function quarterStart({ year, quarter }: Quarter): Date {
  return new Date(Date.UTC(year, (quarter - 1) * 3, 1));
}

/**
 * The first instant of the following quarter.
 *
 * Exclusive, so the last day of the quarter is included whole rather than cut
 * off at midnight — the same convention `jobber-backfill-window.mjs` uses.
 */
export function quarterEnd(quarter: Quarter): Date {
  return quarterStart(nextQuarter(quarter));
}

export function nextQuarter({ year, quarter }: Quarter): Quarter {
  return quarter === 4 ? { year: year + 1, quarter: 1 } : { year, quarter: (quarter + 1) as QuarterNumber };
}

export function previousQuarter({ year, quarter }: Quarter): Quarter {
  return quarter === 1 ? { year: year - 1, quarter: 4 } : { year, quarter: (quarter - 1) as QuarterNumber };
}

/** `Q4 2026`. The form the office already writes in Jobber visit titles. */
export function quarterLabel({ year, quarter }: Quarter): string {
  return `Q${quarter} ${year}`;
}

export function sameQuarter(a: Quarter, b: Quarter): boolean {
  return a.year === b.year && a.quarter === b.quarter;
}

/** The day planning for a quarter should begin. */
export function planningOpensOn(quarter: Quarter, leadDays = DEFAULT_PLANNING_LEAD_DAYS): Date {
  return new Date(quarterStart(quarter).getTime() - leadDays * MS_PER_DAY);
}

/**
 * The quarter a plan should exist for today, or null.
 *
 * A window, not a single date, and that is the whole point. A cron that fired
 * only on the exact day fourteen days out would skip the quarter entirely if
 * the container happened to be restarting that morning, and nothing would
 * report it — the next anybody would hear is that no inspections were booked.
 *
 * Because generation upserts on `(organization, year, quarter)` and the
 * ordering is deterministic, running every day inside the window is harmless
 * and self-healing: the first run creates the draft and later ones re-derive
 * the same one, leaving any coordinator's edits alone.
 */
export function quarterDueForPlanning(
  today: Date,
  leadDays = DEFAULT_PLANNING_LEAD_DAYS,
): Quarter | null {
  const upcoming = nextQuarter(quarterOf(today));
  return today >= planningOpensOn(upcoming, leadDays) && today < quarterStart(upcoming)
    ? upcoming
    : null;
}

// ---------------------------------------------------------------- rotation

export interface RotationCandidate {
  /**
   * The tenancy's stable hash key, not its row id.
   *
   * `PropertywareTenant` rows are deactivated and recreated by the nightly
   * report sync, so a uuid does not survive between quarters. This does, and
   * matching on it is the only reason a rotation can carry forward at all.
   */
  tenantExternalId: string;
  zone: string | null;
  /** Normalised address. Used only to break a tie, never to rank. */
  addressKey: string | null;
}

/** One tenancy's position in an earlier quarter. */
export interface PriorRank {
  tenantExternalId: string;
  sequence: number;
}

export type OrderSource = 'PRIOR_QUARTER' | 'CARRIED_SKIP' | 'NEW_ENROLLMENT';

export interface RankedStop {
  tenantExternalId: string;
  /** 1-based and contiguous across the returned array. */
  sequence: number;
  /** The position carried forward, or null for a tenancy with no history. */
  previousSequence: number | null;
  orderSource: OrderSource;
}

/**
 * How far back to look for a tenancy's last known position.
 *
 * Four quarters is a year. Beyond that the address has usually changed hands,
 * and carrying a stranger's slot forward is worse than treating the tenancy as
 * new.
 */
export const MAX_CARRY_BACK_QUARTERS = 4;

/**
 * Order this quarter's tenancies by the order they had last quarter.
 *
 * The office's rule, and it is a deliberate choice of *predictability* over
 * fairness: whoever was first in Q3 is first in Q4, so the gap between a
 * tenant's visits stays close to ninety days and the office can tell somebody
 * roughly when to expect the next one. The alternative — rotating, so the last
 * becomes first — spreads the "always inspected in October" burden around but
 * swings a given tenant's interval between roughly thirty and a hundred and
 * fifty days.
 *
 * @param candidates  this quarter's enrolled tenancies, in any order
 * @param priorQuarters  earlier quarters' orders, **newest first**
 */
export function carryForwardOrder(
  candidates: readonly RotationCandidate[],
  priorQuarters: readonly (readonly PriorRank[])[],
): RankedStop[] {
  const lookback = priorQuarters.slice(0, MAX_CARRY_BACK_QUARTERS);
  const ranks = lookback.map(
    (quarter) => new Map(quarter.map((entry) => [entry.tenantExternalId, entry.sequence])),
  );

  const placed = candidates.map((candidate) => {
    const depth = ranks.findIndex((quarter) => quarter.has(candidate.tenantExternalId));
    if (depth === -1)
      return { candidate, carried: null, depth: Number.MAX_SAFE_INTEGER, source: 'NEW_ENROLLMENT' as const };
    return {
      candidate,
      carried: ranks[depth].get(candidate.tenantExternalId) ?? null,
      depth,
      // Depth 0 is last quarter. Anything deeper means the tenancy was skipped,
      // blocked or excluded in between, and it keeps its place rather than
      // being punished for what was usually a data problem.
      source: depth === 0 ? ('PRIOR_QUARTER' as const) : ('CARRIED_SKIP' as const),
    };
  });

  placed.sort((left, right) => {
    // Everyone with a history comes before everyone without one, so a new
    // enrolment joins the back of the queue rather than displacing a tenant
    // who has been waiting their turn since the programme started.
    const leftNew = left.carried === null;
    const rightNew = right.carried === null;
    if (leftNew !== rightNew) return leftNew ? 1 : -1;

    if (!leftNew && !rightNew && left.carried !== right.carried)
      return (left.carried ?? 0) - (right.carried ?? 0);

    // Same carried position, reached from different depths. The deeper one
    // goes first, and the reason is the tenant rather than the data: a rank
    // carried from two quarters back belongs to somebody who was *missed* last
    // quarter, so they have waited about a hundred and eighty days where the
    // other has waited ninety. Resolving the tie toward the longer wait is what
    // stops a tenancy that keeps getting blocked from drifting further back
    // every time somebody fixes it.
    //
    // Note the two numbers are not quite on the same scale: when a tenancy
    // drops out, everyone below it shifts up a place, so last quarter's "2" and
    // the previous quarter's "2" are not the same slot. Nothing here can
    // reconcile that exactly, and this is the direction to be wrong in.
    if (left.depth !== right.depth) return right.depth - left.depth;

    return compareTieBreak(left.candidate, right.candidate);
  });

  // Densified to 1..N. A gap left by a tenancy that un-enrolled is not
  // something a coordinator can act on, and it would make every later
  // sequence drift further from its position each quarter.
  return placed.map((entry, index) => ({
    tenantExternalId: entry.candidate.tenantExternalId,
    sequence: index + 1,
    previousSequence: entry.carried,
    orderSource: entry.source,
  }));
}

/**
 * The last word in the ordering, and it must be total.
 *
 * Two tenancies that compare equal all the way down would be left in whatever
 * order the database returned them, which is not stable between runs — and an
 * unstable order makes the fortnightly regeneration reshuffle stops nobody
 * asked to move. `tenantExternalId` is unique, so ending on it guarantees a
 * total order.
 */
function compareTieBreak(left: RotationCandidate, right: RotationCandidate): number {
  // Zone first: it is the office's own geographic grouping, and it is already
  // written into the Jobber visit titles they read.
  const zone = (left.zone ?? '￿').localeCompare(right.zone ?? '￿');
  if (zone !== 0) return zone;

  const address = (left.addressKey ?? '￿').localeCompare(right.addressKey ?? '￿');
  if (address !== 0) return address;

  return left.tenantExternalId.localeCompare(right.tenantExternalId);
}
