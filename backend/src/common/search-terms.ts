/**
 * What somebody typed into a list's search, as words to look for.
 *
 * A list search used to be one `contains` of the whole text against each field
 * on its own (the office, 2026-10-07: "if I search for a property or a schedule
 * or... the technician, it will not show sometimes"). So the words had to arrive in
 * the order a single field held them: "Rolling Stream Dr" never found "11902
 * Rolling Stream Drive", "Flower Gate 5819" never found "5819 Flower Gate Dr",
 * and a stray comma or double space was enough to miss.
 *
 * Here the text becomes words, and every word has to be found -- in any field,
 * in any order. A street word is found in either of its spellings, so "Dr"
 * finds "Drive" and "Lane" finds "Ln". Words that only say what kind of thing
 * follows ("unit", "apt", "#") are left out: they are in nobody's data.
 */

/** Each street word and the ways addresses here spell it. */
const STREET_WORDS: readonly (readonly string[])[] = [
  ['avenue', 'ave', 'av'],
  ['boulevard', 'blvd'],
  ['circle', 'cir'],
  ['court', 'ct'],
  ['cove', 'cv'],
  ['creek', 'crk'],
  ['crossing', 'xing'],
  ['drive', 'dr'],
  ['expressway', 'expy'],
  ['freeway', 'fwy'],
  ['heights', 'hts'],
  ['highway', 'hwy'],
  ['hollow', 'holw'],
  ['lane', 'ln'],
  ['loop', 'lp'],
  ['meadow', 'mdw'],
  ['meadows', 'mdws'],
  ['parkway', 'pkwy'],
  ['place', 'pl'],
  ['point', 'pt'],
  ['road', 'rd'],
  ['square', 'sq'],
  ['street', 'st'],
  ['terrace', 'ter'],
  ['trail', 'trl'],
  ['way', 'wy'],
  ['north', 'n'],
  ['south', 's'],
  ['east', 'e'],
  ['west', 'w'],
];

const SPELLINGS = new Map<string, readonly string[]>(
  STREET_WORDS.flatMap((spellings) => spellings.map((word) => [word, spellings] as const)),
);

/** Words that say what follows rather than being anything to find. */
const FILLER = new Set(['unit', 'apt', 'apartment', 'suite', 'ste']);

/** Enough for any address and a name; more is somebody pasting a paragraph. */
const MAX_TERMS = 8;

/**
 * The words to find, each with the spellings any of which will do. Empty when
 * nothing searchable was typed. A single letter is kept: "B" for Unit B is a
 * real search, and with other words beside it it narrows rather than widens.
 */
export function searchTerms(raw: string | null | undefined): string[][] {
  const words = (raw ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}@.'-]+/u)
    .map((word) => word.replace(/^[.'-]+|[.'-]+$/g, ''))
    .filter((word) => word && !FILLER.has(word));
  const unique = [...new Set(words)].slice(0, MAX_TERMS);
  return unique.map((word) => [...(SPELLINGS.get(word) ?? [word])]);
}
