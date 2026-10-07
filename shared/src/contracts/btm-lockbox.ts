/**
 * The sign, the Supra key box and the lockbox, on every back-to-market visit.
 *
 * Moses, 2026-10-08: "On BTM inspections, we need an entry that says sign,
 * supra, and lockbox. Questions to add: installed? Key functioning? Insert
 * text box below to notate any notes pertinent to installation of these items
 * or functionality of the key." He had been adding the area by hand on each
 * job. Jobber's own completion steps for the visit already say "Place Sign,
 * Supra, and Lockbox" (`visit-details-writer`); this is where the technician
 * says it was done.
 *
 * Asked as its own area rather than in every room, and answered on the
 * occupied form's rows: organization-wide `OCCUPIED` items carrying this
 * section, the way an HVAC area asks only its own section of that list. Every
 * other room of the visit asks the items with no section -- the two condition
 * questions -- and this area asks only these.
 *
 * Both questions must be answered before the area can be submitted, and a
 * photograph is needed as in every back-to-market area; the notes are
 * optional (the office, 2026-10-08). The notes are an answer rather than the
 * area's own note because answers print on the report and that note does not.
 */

export const BTM_LOCKBOX_AREA_NAME = 'Sign, supra and lockbox';

/** The checklist section this area asks; its own name, as HVAC's sections are. */
export const BTM_LOCKBOX_SECTION = BTM_LOCKBOX_AREA_NAME;

/** "Yes" and "No", in that order: the answer the office hopes for first. */
export const BTM_LOCKBOX_YES = 'Yes';
export const BTM_LOCKBOX_NO = 'No';

export interface BtmLockboxItem {
  label: string;
  responseType: 'CHOICE' | 'TEXT';
  choices: string[];
  /** Must be answered before the area can be submitted. */
  required: boolean;
}

export const BTM_LOCKBOX_CHECKLIST: readonly BtmLockboxItem[] = [
  { label: 'Installed?', responseType: 'CHOICE', choices: [BTM_LOCKBOX_YES, BTM_LOCKBOX_NO], required: true },
  { label: 'Key functioning?', responseType: 'CHOICE', choices: [BTM_LOCKBOX_YES, BTM_LOCKBOX_NO], required: true },
  // Unique among the occupied rows, which are found by label: a plain "Notes"
  // would collide with any note added to the list later.
  { label: 'Notes on installation or the key', responseType: 'TEXT', choices: [], required: false },
] as const;

/**
 * Whether an area is this one, by its name.
 *
 * Lenient on purpose: technicians typed it themselves before it was built in
 * ("Sign, supra and lockbox"), and Jobber spells it "Sign, Supra, and
 * Lockbox". Any of those asks these questions; the area the app adds is always
 * spelled `BTM_LOCKBOX_AREA_NAME`.
 */
export function isBtmLockboxArea(name: string | null | undefined): boolean {
  const words = (name ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word && word !== 'and');
  return words.join(' ') === 'sign supra lockbox';
}

/** The labels of the questions still to answer, in the order they are asked. */
export function unansweredLockboxQuestions(
  answers: readonly { label: string; textValue?: string | null }[],
): string[] {
  const answered = new Set(
    answers.filter((answer) => (answer.textValue ?? '').trim()).map((answer) => answer.label),
  );
  return BTM_LOCKBOX_CHECKLIST.filter((item) => item.required && !answered.has(item.label)).map(
    (item) => item.label,
  );
}

/** What the phone and the server both say when a question is still unanswered. */
export function lockboxUnansweredMessage(labels: readonly string[]): string {
  return `Answer ${labels.map((label) => `"${label}"`).join(' and ')} before submitting this area.`;
}
