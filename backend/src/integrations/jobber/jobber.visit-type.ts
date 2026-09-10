import { InspectionType } from '@prisma/client';

/**
 * Deciding which kind of inspection a Jobber visit is.
 *
 * Jobber has no concept of our inspection types, and the type is not cosmetic:
 * it picks the area scope, decides whether a move-in baseline is required, and
 * determines what the visit is later compared against. Getting it wrong
 * produces a plausible-looking inspection scoped to the wrong rooms.
 *
 * So this never guesses. A visit whose title matches exactly one rule is
 * typed; anything else — no match, or two matches — is refused with a named
 * reason and waits for a person. The office renaming a job template should
 * stall the import, not silently reclassify a year of inspections.
 */

export type VisitTypeResolution =
  | { outcome: 'RESOLVED'; inspectionType: InspectionType }
  | { outcome: 'UNKNOWN' }
  | { outcome: 'AMBIGUOUS'; matches: InspectionType[] };

/**
 * Default title keywords, lowercased and matched as substrings.
 *
 * Ordered longest-phrase-first within a type so "move out" cannot be shadowed
 * by a shorter rule. Overridable with JOBBER_VISIT_TYPE_RULES because these are
 * the office's words, not ours, and hardcoding them would mean a deploy every
 * time a job template is renamed.
 */
export const DEFAULT_VISIT_TYPE_RULES: Record<InspectionType, string[]> = {
  [InspectionType.MOVE_IN]: ['move in', 'move-in', 'movein'],
  [InspectionType.MOVE_OUT]: ['move out', 'move-out', 'moveout'],
  [InspectionType.BACK_TO_MARKET]: ['back to market', 'back-to-market', 'btm'],
  [InspectionType.OCCUPIED]: ['occupied', 'periodic', 'routine'],
  [InspectionType.HVAC]: ['hvac', 'air conditioning', 'ac service'],
  [InspectionType.ROOF]: ['roof'],
  [InspectionType.SUPRA_LOCKBOX_PLACEMENT]: ['lockbox placement', 'place lockbox', 'supra place'],
  [InspectionType.SUPRA_LOCKBOX_REMOVAL]: ['lockbox removal', 'remove lockbox', 'supra remove'],
  // "Tenant Benefit Package" is what this office calls the filter-delivery
  // programme, and it is by far the most scheduled visit in their calendar —
  // 101 of 211 on the first live sync. "tbp" catches the abbreviated form
  // ("Q3 TBP Filter Change + Pest Control"). Confirmed against real titles
  // rather than guessed.
  [InspectionType.AC_FILTER_DELIVERY]: [
    'tenant benefit package',
    'tbp',
    'filter delivery',
    'ac filter',
    'air filter',
  ],
};

/**
 * Reads an override from the environment.
 *
 * A malformed value falls back to the defaults rather than throwing: the sync
 * refusing to start is a worse outcome than it running with the rules that were
 * already working, and an unknown title is refused per visit anyway.
 */
export function visitTypeRules(
  env: NodeJS.ProcessEnv = process.env,
): Record<InspectionType, string[]> {
  const raw = env.JOBBER_VISIT_TYPE_RULES?.trim();
  if (!raw) return DEFAULT_VISIT_TYPE_RULES;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rules = { ...DEFAULT_VISIT_TYPE_RULES };
    for (const [type, keywords] of Object.entries(parsed)) {
      if (!(type in DEFAULT_VISIT_TYPE_RULES)) continue;
      if (!Array.isArray(keywords) || keywords.some((word) => typeof word !== 'string')) continue;
      rules[type as InspectionType] = (keywords as string[]).map((word) =>
        word.toLowerCase().trim(),
      );
    }
    return rules;
  } catch {
    return DEFAULT_VISIT_TYPE_RULES;
  }
}

/**
 * The single inspection type a visit's title names, if exactly one does.
 *
 * Two types matching is treated as ambiguous rather than resolved by
 * precedence. "Move out and lockbox removal" is genuinely two jobs, and picking
 * either would scope the inspection to the wrong areas — the office is the only
 * one who can say which visit this is.
 */
export function resolveVisitType(
  title: string | null | undefined,
  rules: Record<InspectionType, string[]> = visitTypeRules(),
): VisitTypeResolution {
  const haystack = (title ?? '').toLowerCase();
  if (!haystack.trim()) return { outcome: 'UNKNOWN' };
  const matches = (Object.entries(rules) as [InspectionType, string[]][])
    .filter(([, keywords]) => keywords.some((word) => word && haystack.includes(word)))
    .map(([type]) => type);
  if (!matches.length) return { outcome: 'UNKNOWN' };
  if (matches.length > 1) return { outcome: 'AMBIGUOUS', matches };
  return { outcome: 'RESOLVED', inspectionType: matches[0] };
}

/**
 * Inspection types the sync may book against a property nobody has surveyed.
 *
 * `allowTechnicianAreaCapture` lets the technician build the area list on site;
 * what they add lands on the property as DRAFT, so an administrator still
 * approves the permanent layout. It delegates the survey, not the approval.
 *
 * HVAC is off-cycle equipment work: a visit to a property where recording what
 * is actually there is a free and accurate survey, and it is never compared
 * against another inspection, so an on-site area list harms nothing downstream.
 *
 * MOVE_IN is here for a different reason, and the earlier argument against it
 * was wrong. A move-in does establish the baseline every later inspection is
 * judged against — but what the technician captures is written to the property
 * as DRAFT, and an administrator still approves what becomes the permanent
 * layout. The survey is delegated; the approval is not. And a move-in is
 * precisely when a property is first walked, so refusing it left ten of them
 * unimportable for a plan nobody had drawn and nobody was going to draw first.
 *
 * MOVE_OUT, OCCUPIED and BACK_TO_MARKET were excluded on the argument that all
 * three are read against a move-in area by area, so a layout captured on the
 * visit itself compares against nothing. That argument is sound and it is not
 * what was happening.
 *
 * On the live calendar these were ten move-outs at properties with **no
 * approved area at all** and **no move-in on record** — the comparison had
 * nothing to compare against either way. The real choice was not "compared
 * inspection versus surveyed inspection", it was "surveyed inspection versus
 * no inspection", and the visits were happening regardless. Two of them that
 * day.
 *
 * What the technician captures is DRAFT against the property, and an
 * administrator still approves what becomes the permanent layout, so a
 * surveyed move-out cannot silently rewrite a layout a real move-in
 * established. Where a baseline does exist it is still linked and still
 * compared; `ComparisonService` reports its absence rather than failing when
 * it does not.
 *
 * Filter delivery used to be here. It is no longer imported at all — see
 * TYPES_NOT_SYNCED — so an entry for it would be unreachable.
 *
 * Roof and the two lockbox visits are left out for now rather than on
 * principle: nobody has asked for them.
 */
const TYPES_ALLOWING_TECHNICIAN_CAPTURE: ReadonlySet<InspectionType> = new Set([
  InspectionType.HVAC,
  InspectionType.MOVE_IN,
  InspectionType.MOVE_OUT,
  InspectionType.OCCUPIED,
  InspectionType.BACK_TO_MARKET,
]);

export function allowsTechnicianCapture(inspectionType: InspectionType): boolean {
  return TYPES_ALLOWING_TECHNICIAN_CAPTURE.has(inspectionType);
}

/**
 * Types this integration will not turn into inspections.
 *
 * `AC_FILTER_DELIVERY` exists in the app's own model — added with the roof and
 * lockbox visits long before Jobber — but it is a *delivery*: somebody drops off
 * filters, and nobody inspects anything. Importing it put ~100 jobs in front of
 * technicians under the word "inspection".
 *
 * A visit typed this way is recorded and skipped rather than refused. The
 * distinction matters in the console: a refusal is work waiting for someone,
 * and this is a decision already made that would otherwise reappear on every
 * sync as noise nobody can clear.
 *
 * This does not remove the type from the app. Anything created by hand still
 * works exactly as before; only the Jobber importer declines to produce them.
 */
const TYPES_NOT_SYNCED: ReadonlySet<InspectionType> = new Set([
  InspectionType.AC_FILTER_DELIVERY,
]);

/**
 * Phrases that mean a filter delivery is also a walkthrough.
 *
 * This office books both as one visit: the title is "Q3 2026 Tenant Benefit
 * Package" and the details read "Filter Change: 18x36x1 + Pest Control +
 * Occupied Inspection". The title alone types it a delivery and it is dropped,
 * so 73 real occupied inspections were never imported and none has ever
 * existed in this system.
 */
const OCCUPIED_IN_DETAILS = ['occupied inspection', 'occupied insp'];

/**
 * A filter delivery that is also an occupied inspection.
 *
 * Deliberately narrow. It reads the details *only* when the title already
 * resolved to a delivery, and can only ever produce `OCCUPIED` -- it never
 * overrides a title that resolved to something else, and never rescues a title
 * that resolved to nothing.
 *
 * That asymmetry is the point. A title is what the office deliberately names a
 * job; details are free text where anything may appear, including the word
 * "inspection" inside a sentence saying one is *not* needed. Letting free text
 * override a chosen title would reclassify work on a phrase nobody was asked to
 * be careful about, and the type decides area scope and what a move-out is
 * later compared against.
 *
 * The delivery itself is not lost by this: it was never imported. It stays in
 * Jobber, which is where the filters are actually tracked.
 */
export function occupiedInspectionInDetails(details: string | null | undefined): boolean {
  if (!details) return false;
  const haystack = details.toLowerCase();
  return OCCUPIED_IN_DETAILS.some((phrase) => haystack.includes(phrase));
}

/**
 * Words in a title that mean the office booked an inspection.
 *
 * ── WHY A TITLE HAS TO SAY IT ────────────────────────────────────────────────
 *
 * The type rules match equipment and place names — `hvac`, `roof` — because
 * that is how the office names an inspection *of* those things. They also match
 * how it names ordinary repair work on them, and Jobber holds far more of the
 * second. On the live calendar every visit that resolved to HVAC was a repair
 * work order: "Zone 4 - HVAC - #44027", ten of them, each imported as an
 * inspection and put in front of a technician under that word.
 *
 * The rest of the maintenance calendar — cleaning, drywall, a smoke alarm, a
 * water leak — matched nothing and was refused as an unknown type, which is
 * worse than it sounds: a refusal is work waiting for a person, so eighteen
 * work orders nobody was ever going to import sat in the console as a queue.
 *
 * ── WHY NOT THE WORK ORDER NUMBER ────────────────────────────────────────────
 *
 * Those titles carry one — `#44027`, `WO#44098`, a bare trailing `43000` — and
 * keying on it is the obvious rule. It is also wrong. Twelve real move-in
 * inspections carry a work order number too, because the office bundles the
 * inspection with the code work it is booked alongside:
 *
 *   "21227 Teal Lovegrass Ln ... - Code Work + Move in Inspection - Work Order #42914"
 *
 * Excluding on the number drops eleven genuine inspections. The number
 * correlates with work orders; the missing word is what actually distinguishes
 * them, and on the live calendar it separates the two sets completely.
 *
 * ── THE MISSPELLINGS ARE REAL ────────────────────────────────────────────────
 *
 * `insp` rather than `inspection` because the office types these by hand and
 * gets them wrong: "Move in inspeciton" is a real title of a real move-in.
 * `inscpection` is listed separately because it transposes the c and cannot be
 * caught by any prefix of the correct spelling. Both are from live data, not
 * imagined.
 */
const INSPECTION_TITLE_MARKERS = ['insp', 'inscpection'];

/** Whether the title itself names the visit an inspection. */
export function titleNamesAnInspection(title: string | null | undefined): boolean {
  const haystack = (title ?? '').toLowerCase();
  return INSPECTION_TITLE_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Whether this visit is an inspection at all, by title or by details.
 *
 * The details half is the occupied case and nothing wider: this office books
 * the walkthrough inside a filter delivery, so sixty-seven live occupied
 * inspections have a title that never says the word. `occupiedInspectionInDetails`
 * is deliberately narrow about that — see its own note — and this reuses it
 * rather than opening free text up as a second source of truth.
 */
export function namesAnInspection(
  title: string | null | undefined,
  details: string | null | undefined,
): boolean {
  return titleNamesAnInspection(title) || occupiedInspectionInDetails(details);
}

/** Shown in the console against a visit skipped for not being an inspection. */
export const NOT_AN_INSPECTION_REASON =
  'This visit is not named as an inspection, so it is treated as other work and not imported. Rename the job in Jobber if it is one.';

export function isSyncedType(inspectionType: InspectionType): boolean {
  return !TYPES_NOT_SYNCED.has(inspectionType);
}

/** Why a type is skipped, in words the console can show. */
export function notSyncedReason(inspectionType: InspectionType): string {
  return inspectionType === InspectionType.AC_FILTER_DELIVERY
    ? 'Filter delivery is a delivery, not an inspection, so it is not imported.'
    : 'This visit type is not imported as an inspection.';
}
