import type { AdminInspectionComparison } from '@texasrenters/shared';

/**
 * What stops a comparison being shared with an owner or tenant, in the order to
 * fix it: regenerate first (that undoes an approval), then decide the rooms,
 * then approve. Empty when it can be shared.
 *
 * The server refuses the same three (`ReportShareService`), so this only says
 * so before a reviewer presses the button rather than after.
 */
export function comparisonShareBlockers(
  comparison: Pick<AdminInspectionComparison, 'status' | 'undecidedRooms' | 'outOfDateText'>,
) {
  const blockers: string[] = [];
  if (comparison.outOfDateText)
    blockers.push(`Out of date: ${comparison.outOfDateText} Regenerate it, then approve it again.`);
  const undecided = comparison.undecidedRooms ?? 0;
  if (undecided)
    blockers.push(
      `${undecided} ${undecided === 1 ? 'room is' : 'rooms are'} still marked Requires review: decide ${undecided === 1 ? 'it' : 'each'} with Override, giving the reason the report will print.`,
    );
  if (comparison.status !== 'APPROVED')
    blockers.push('Not approved yet: an owner or tenant only sees an approved comparison.');
  return blockers;
}
