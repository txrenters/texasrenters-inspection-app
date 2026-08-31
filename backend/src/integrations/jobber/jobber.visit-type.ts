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
  [InspectionType.AC_FILTER_DELIVERY]: ['filter delivery', 'ac filter', 'air filter'],
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
