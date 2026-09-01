/**
 * Address matching between Jobber and Propertyware.
 *
 * These two systems share no key, so an address string is the only thing they
 * have in common — and an address string is a bad key. Everything here is
 * therefore built to be *conservative*: it either produces exactly one
 * confident answer or it produces none and sends the property to a human. A
 * wrong link does not fail loudly; it sends a technician to the wrong door and
 * files the photos against somebody else's property.
 */

/** Written forms that mean the same street, collapsed to one. Deliberately
 * short: every entry is a chance to make two different streets look alike. */
const STREET_SUFFIXES: Record<string, string> = {
  street: 'st',
  avenue: 'ave',
  boulevard: 'blvd',
  drive: 'dr',
  road: 'rd',
  lane: 'ln',
  court: 'ct',
  circle: 'cir',
  place: 'pl',
  trail: 'trl',
  parkway: 'pkwy',
  highway: 'hwy',
  terrace: 'ter',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  northeast: 'ne',
  northwest: 'nw',
  southeast: 'se',
  southwest: 'sw',
};

/**
 * ZIP+4 down to the five digits both systems reliably agree on.
 *
 * Propertyware and Jobber disagree about the +4 often enough that including it
 * turns real matches into misses, and the five-digit prefix is already narrow
 * enough to be doing the work here.
 */
export function normalizePostalCode(value: string | null | undefined): string {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.slice(0, 5);
}

/**
 * Strips what is written in an address line but is not part of the address.
 *
 * Two things, both observed in live data rather than imagined:
 *
 * **Parenthetical notes.** The office marks retired Jobber properties
 * "(Do not use)", so `3002 Thicket Path Way (Do not use)` never matched the
 * `3002 Thicket Path Way` Propertyware holds. A parenthetical never
 * distinguishes two real addresses, so removing it cannot merge two places.
 *
 * **A city/state/ZIP tail.** Many Propertyware rows carry the whole address in
 * line 1 — `1508B Creekside Ln, Nacogdoches, Texas 75964` — while Jobber sends
 * only the street. Cutting at the first comma leaves the street line, because a
 * US street line does not contain one before the city. Eleven Nacogdoches
 * properties were unmatchable for this reason alone.
 */
function streetPart(value: string | null | undefined): string {
  return (value ?? '').replace(/\([^)]*\)/g, ' ').split(',')[0] ?? '';
}

function normalizeWords(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => STREET_SUFFIXES[word] ?? word)
    .join(' ')
    .trim();
}

/**
 * The key two addresses must share to be considered the same place.
 *
 * Street line plus five-digit ZIP, lowercased, punctuation removed and common
 * suffixes collapsed. City and state are deliberately excluded: they are
 * redundant given the ZIP and they disagree constantly ("Ft Worth" / "Fort
 * Worth"), so including them would only ever lose matches.
 *
 * Returns an empty string when there is not enough to match on, which callers
 * must treat as "no key" rather than as a key that happens to be empty —
 * otherwise every address-less property would match every other one.
 */
export function normalizeAddressKey(
  addressLine1: string | null | undefined,
  postalCode: string | null | undefined,
): string {
  const postal = normalizePostalCode(postalCode);
  const street = normalizeWords(streetPart(addressLine1));
  if (!street || !postal) return '';
  return `${street}|${postal}`;
}

/**
 * The keys an address could legitimately be filed under, most specific first.
 *
 * Jobber splits a unit onto its own line — `5200 Weslayan Street` +
 * `unit a201` — while Propertyware writes it inline:
 * `5200 Weslayan Street Unit #A201`. Neither is wrong, and neither matches the
 * other unless the two lines are folded together.
 *
 * Both forms are returned because both are real answers. The unit-bearing key
 * identifies one home and is tried first; the street-only key identifies the
 * building, which is the right answer when Propertyware holds the building and
 * models its units separately. Trying them in that order is what keeps a
 * specific match from being lost to a broader one — never the reverse.
 */
export function addressKeyCandidates(
  addressLine1: string | null | undefined,
  addressLine2: string | null | undefined,
  postalCode: string | null | undefined,
): string[] {
  const postal = normalizePostalCode(postalCode);
  const street = normalizeWords(streetPart(addressLine1));
  if (!street || !postal) return [];
  const unit = normalizeWords(streetPart(addressLine2));
  return unit ? [`${street} ${unit}|${postal}`, `${street}|${postal}`] : [`${street}|${postal}`];
}

export interface AddressCandidate {
  id: string;
  addressLine1: string | null;
  postalCode: string | null;
}

/**
 * Groups candidates by their normalized key.
 *
 * Built once per sync run rather than queried per property: the building set is
 * small enough to hold, and normalizing in the database would mean keeping a
 * second copy of these rules in SQL.
 */
export function buildAddressIndex(candidates: readonly AddressCandidate[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const candidate of candidates) {
    const key = normalizeAddressKey(candidate.addressLine1, candidate.postalCode);
    if (!key) continue;
    const existing = index.get(key);
    if (existing) existing.push(candidate.id);
    else index.set(key, [candidate.id]);
  }
  return index;
}

export type AddressMatch =
  | { outcome: 'MATCHED'; buildingId: string }
  | { outcome: 'NONE' }
  | { outcome: 'AMBIGUOUS'; buildingIds: string[] };

/**
 * Exactly one candidate, or nothing.
 *
 * Two buildings sharing a normalized address is a real situation — a duplex
 * entered twice, a complex whose units carry the street address — and there is
 * no tiebreak available here that would not be a guess.
 */
export function matchBuilding(
  index: Map<string, string[]>,
  keys: string | readonly string[],
): AddressMatch {
  /**
   * The first key that hits anything decides, including when what it hits is
   * ambiguous.
   *
   * Falling past an ambiguous specific key to a broader one would answer a
   * question nobody asked: if two homes share `5200 weslayan st unit a201`,
   * quietly linking the building instead hides a real conflict behind a match
   * that looks clean.
   */
  for (const key of typeof keys === 'string' ? [keys] : keys) {
    if (!key) continue;
    const candidates = index.get(key);
    if (!candidates?.length) continue;
    if (candidates.length > 1) return { outcome: 'AMBIGUOUS', buildingIds: candidates };
    return { outcome: 'MATCHED', buildingId: candidates[0] };
  }
  return { outcome: 'NONE' };
}
