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
  const street = (addressLine1 ?? '')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => STREET_SUFFIXES[word] ?? word)
    .join(' ')
    .trim();
  if (!street || !postal) return '';
  return `${street}|${postal}`;
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
export function matchBuilding(index: Map<string, string[]>, key: string): AddressMatch {
  if (!key) return { outcome: 'NONE' };
  const candidates = index.get(key);
  if (!candidates?.length) return { outcome: 'NONE' };
  if (candidates.length > 1) return { outcome: 'AMBIGUOUS', buildingIds: candidates };
  return { outcome: 'MATCHED', buildingId: candidates[0] };
}
