import {
  checklistKindFor,
  checklistTemplateForKind,
  keywordsFromLabel,
} from '@texasrenters/shared';

import type { AreaEnvironment, InspectionRoom } from '../domain/models';

export interface ChecklistItem {
  id: string;
  /** Shown to the technician. */
  label: string;
  /**
   * Words that count as having covered this item when spoken.
   *
   * Matching is on these rather than the label because a technician says
   * "the taps are fine", not "plumbing fixtures and taps".
   */
  keywords: string[];
}

// The per-area tables that used to live here are gone: the shared template in
// @texasrenters/shared is now the single source, so the offline fallback and
// the list the server generates cannot disagree.

/**
 * Which checklist an area actually shows: the authored one, or a generated
 * fallback for an area nobody has configured.
 *
 * Pure so both the area screen and the camera can reach the same answer, and so
 * the rule is testable without a renderer. They previously each decided for
 * themselves, and one of them never fetched the authored list at all.
 */
export function resolveAreaChecklist(
  authored: readonly { id: string; label: string; keywords: string[] }[] | undefined,
  area: {
    name?: string | null;
    environment?: AreaEnvironment;
    category?: string | null;
    inspectionType?: string | null;
  },
): ChecklistItem[] {
  if (authored?.length)
    return authored.map((item) => ({
      id: item.id,
      label: item.label,
      keywords: item.keywords,
    }));
  return checklistForArea({
    name: area.name ?? '',
    environment: area.environment,
    category: area.category,
    inspectionType: area.inspectionType,
  });
}

/**
 * The fallback list for an area the API has not sent one for.
 *
 * Built from the shared template — the same table the server generates from —
 * so a fallback shown offline matches the list that area will have once its
 * checklist arrives. The lists that used to live in this file were written
 * independently and said different things: a technician who lost signal saw a
 * different kitchen from the one an administrator had approved.
 *
 * Ids are the labels, so a locally ticked item keeps its meaning if the real
 * items arrive mid-walkthrough; `checklistProgress` already counts only ids
 * still on the list, so anything that no longer matches is simply dropped.
 */
export function checklistForArea(
  area: Pick<InspectionRoom, 'name'> & {
    environment?: AreaEnvironment;
    /** Dropped on the way in until now, so this fallback ignored the category
        an administrator had set and could disagree with the server's list. */
    category?: string | null;
    /** An HVAC visit falls back to the equipment items, not the room ones. */
    inspectionType?: string | null;
  },
): ChecklistItem[] {
  return checklistTemplateForKind(
    { name: area.name, environment: area.environment, category: area.category },
    checklistKindFor(area.inspectionType),
  ).map((label) => ({
    id: label,
    label,
    keywords: keywordsFromLabel(label),
  }));
}

/**
 * Which checklist items a piece of speech covers.
 *
 * Kept pure and free of any speech API so the same rule serves both possible
 * sources: live on-device recognition, and the server transcript that already
 * exists for every uploaded recording. Only the caller differs.
 *
 * Returns ids rather than mutating, so the caller decides whether a mention is
 * enough to tick something — a decision that belongs with the technician, not
 * with a keyword table.
 */
export function matchChecklistMentions(items: readonly ChecklistItem[], spoken: string): string[] {
  const haystack = ` ${spoken.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  if (haystack.trim().length === 0) return [];
  return items
    .filter((item) =>
      item.keywords.some((keyword) => {
        const needle = keyword.toLowerCase();
        // Word-boundary padded rather than a bare `includes`: "drain" must not
        // fire on "draining board", and "tap" must never match "tape".
        return haystack.includes(` ${needle} `) || haystack.includes(` ${needle}s `);
      }),
    )
    .map((item) => item.id);
}

/** How much of the list has been covered, for the progress line. */
export function checklistProgress(items: ChecklistItem[], checkedIds: readonly string[]) {
  const known = new Set(items.map((item) => item.id));
  // Counts only ids still on the list: a checklist that changes shape must not
  // report 6 of 5 covered from a stale saved id.
  const covered = new Set(checkedIds.filter((id) => known.has(id)));
  return { covered: covered.size, total: items.length };
}
