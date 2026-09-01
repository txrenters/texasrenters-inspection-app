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
 * MOVE_OUT is still excluded, and now for a sharper reason than "the lifecycle
 * chain": it is compared to its move-in area by area. A layout captured on the
 * move-out visit itself would be a comparison against nothing.
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

export function isSyncedType(inspectionType: InspectionType): boolean {
  return !TYPES_NOT_SYNCED.has(inspectionType);
}

/** Why a type is skipped, in words the console can show. */
export function notSyncedReason(inspectionType: InspectionType): string {
  return inspectionType === InspectionType.AC_FILTER_DELIVERY
    ? 'Filter delivery is a delivery, not an inspection, so it is not imported.'
    : 'This visit type is not imported as an inspection.';
}
