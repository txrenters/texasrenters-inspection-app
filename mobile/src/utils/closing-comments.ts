/**
 * The closing block of the office's HVAC report: Next Inspection Alert,
 * Maintenance Comments and General Comments.
 *
 * Written by the technician on the final review and sent with the submission;
 * the office can edit them afterwards (2026-09-16). Only an HVAC inspection's
 * report ends on them.
 */
export interface ClosingComments {
  nextInspectionAlert: string;
  maintenanceComments: string;
  generalComments: string;
}

export const EMPTY_CLOSING_COMMENTS: ClosingComments = {
  nextInspectionAlert: '',
  maintenanceComments: '',
  generalComments: '',
};

/** Whether this kind of visit closes on these comments. */
export function asksClosingComments(inspectionType: string | null | undefined): boolean {
  return inspectionType === 'HVAC';
}

/**
 * What to send: only the fields written, trimmed.
 *
 * A blank field is left out rather than sent empty, because the server reads an
 * empty one as "clear it" -- and a technician who wrote nothing has not asked to
 * erase what the office wrote. Undefined when nothing was written at all.
 */
export function closingCommentsToSend(draft: ClosingComments): Partial<ClosingComments> | undefined {
  const written = (Object.keys(draft) as (keyof ClosingComments)[])
    .map((key) => [key, draft[key].trim()] as const)
    .filter(([, value]) => value.length > 0);
  return written.length ? Object.fromEntries(written) : undefined;
}
