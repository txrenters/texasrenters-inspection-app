/**
 * What an occupied inspection asks about a room.
 *
 * Source: field feedback from the beta, 2026-09-09. An occupied visit was being
 * served the byte-identical per-room list as a move-out — `checklistTemplateFor`
 * takes an area and nothing else, and no caller had ever passed it an inspection
 * type. For a three-bed, two-bath house that is roughly eighty items, each a
 * tri-state on three axes, against a visit the office allows fifteen minutes.
 *
 * The two are not the same job. A move-out is the record a tenancy is judged
 * and charged against, so every component is evaluated and documented
 * separately. An occupied inspection is a periodic look around somebody's home
 * during their tenancy: the question is whether the room is in acceptable
 * condition and whether anything needs attention, and anything that does gets a
 * finding — which is photographable, reviewable and chargeable, and is a far
 * better record than a tick.
 *
 * ── WHY THESE ARE ORGANIZATION-WIDE ROWS ─────────────────────────────────────
 *
 * `propertyAreaId: null`, exactly as the HVAC list is. These two questions are
 * the same in every room of every property, so writing them per area would copy
 * the same pair across the whole portfolio and leave every copy to be kept in
 * step when the office rewords an option.
 *
 * That does not merge the answers. `InspectionAreaChecklistResponse` is unique
 * on `(inspectionAreaId, checklistItemId)`, so the kitchen's answer and the
 * second bedroom's answer are separate rows pointing at the one shared item.
 *
 * ── WHY CHOICE RATHER THAN THE THREE FLAGS ───────────────────────────────────
 *
 * Clean / undamaged / working are three independent booleans, which is three
 * decisions per item and admits combinations nobody means. The office asked for
 * one answer per room, and `CHOICE` — built for the HVAC form — already stores
 * the chosen option's own words rather than an index, so reordering or
 * rewording the options never rewrites what a technician recorded.
 *
 * The words below are the office's, quoted from the feedback. They are stored
 * on the row rather than modelled as an enum for the same reason the HVAC
 * choices are: the office rewords them, and a migration should not be the price
 * of changing a label on a form.
 */

/** How one item is answered. Structurally the HVAC shape, deliberately. */
export interface OccupiedChecklistItem {
  label: string;
  /** Always CHOICE here. Named rather than assumed, so the row writer is honest. */
  responseType: 'CHOICE';
  choices: string[];
}

/**
 * How the room presented itself. The tenant's side of the visit.
 *
 * "Damaged" sits in a list that is otherwise about cleanliness because that is
 * how the office wrote it, and a technician reading the printed form and a
 * technician reading the phone must see the same four words. Damage found here
 * still belongs in a finding; this records the room's overall state, not the
 * detail of what was wrong with it.
 */
export const OCCUPIED_ROOM_CONDITION_CHOICES = [
  'Clean',
  'Acceptable',
  'Damaged',
  'Needs attention',
] as const;

/** How the room is holding up. The property's side of the same visit. */
export const OCCUPIED_OVERALL_CONDITION_CHOICES = ['Good', 'Fair', 'Poor'] as const;

/**
 * The whole occupied checklist. Two items, in the order they are asked.
 *
 * Kept as a list rather than two constants so the row writer, the mobile
 * fallback and any future report column all iterate one definition — the same
 * reason `HVAC_CHECKLIST` is a list. Adding a third question here reaches every
 * organization at its next occupied inspection.
 *
 * `section` is deliberately absent. Sections group a sixty-item form; two items
 * do not need a heading, and giving them one would print an empty-looking
 * subheading above every room in the report.
 */
export const OCCUPIED_CHECKLIST: readonly OccupiedChecklistItem[] = [
  {
    label: 'Room condition',
    responseType: 'CHOICE',
    choices: [...OCCUPIED_ROOM_CONDITION_CHOICES],
  },
  {
    label: 'Overall condition',
    responseType: 'CHOICE',
    choices: [...OCCUPIED_OVERALL_CONDITION_CHOICES],
  },
] as const;

/**
 * The labels an occupied inspection asks, for callers that only want wording.
 *
 * Parallel to `airConditioningChecklistTemplate`, so `checklistTemplateForKind`
 * can answer all three kinds in the same shape. Callers that need the response
 * type and the options — the row writer, and the offline fallback — read
 * `OCCUPIED_CHECKLIST` directly rather than this.
 */
export function occupiedChecklistTemplate(): string[] {
  return OCCUPIED_CHECKLIST.map((item) => item.label);
}
