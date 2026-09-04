import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Copying the technician onto an inspection that arrived already finished.
 *
 * `applyAssignment` used to refuse anything that was not SCHEDULED. That reads
 * as "never rewrite who did work that is already done", which is right — but it
 * also refused the *first* assignment on a record that had none, and the
 * recovered move-ins are exactly that: created COMPLETED, because Jobber closed
 * the visit before this system ever saw it.
 *
 * The result was 144 completed inspections showing "Unassigned" in the console
 * while Jobber had known who walked every one of them. The assignee is the
 * record the office wanted; refusing to store it lost the only copy we had.
 *
 * Asserted against the worker source, matching the sibling
 * `jobber-completed-move-in.spec.ts`: what is being pinned is which of two
 * conditions must hold before the sync declines, and the order they are written
 * in is the clearest statement of that.
 */

const WORKER = readFileSync(
  join(__dirname, '..', 'src', 'workers', 'jobber-sync', 'jobber-sync.worker.ts'),
  'utf8',
);

const APPLY_ASSIGNMENT = WORKER.slice(
  WORKER.indexOf('private async applyAssignment'),
  WORKER.indexOf('private async reject'),
);

describe('assigning a technician to an inspection that is already complete', () => {
  it('no longer refuses purely because the inspection is not scheduled', () => {
    // The exact shape of the old guard. If it comes back, every recovered
    // move-in silently loses its technician again — silently, because an
    // unassigned inspection looks like one nobody has got to yet.
    expect(APPLY_ASSIGNMENT).not.toContain(
      'inspection.startedAt || inspection.status !== InspectionStatus.SCHEDULED',
    );
  });

  it('refuses only when the work has begun AND somebody is already named', () => {
    // Both halves matter. Dropping the second refuses the first assignment on a
    // recovered record; dropping the first lets a later sync overwrite the
    // technician who actually did the work.
    expect(APPLY_ASSIGNMENT).toContain('worked && current');
    const worked = APPLY_ASSIGNMENT.slice(
      APPLY_ASSIGNMENT.indexOf('const worked ='),
      APPLY_ASSIGNMENT.indexOf('if (worked && current)'),
    );
    expect(worked).toContain('inspection.startedAt');
    expect(worked).toContain('InspectionStatus.SCHEDULED');
  });

  it('still protects an inspection that has been worked and assigned', () => {
    // The original purpose of the guard, which this change must not lose.
    const guardIndex = APPLY_ASSIGNMENT.indexOf('if (worked && current) return;');
    expect(guardIndex).toBeGreaterThan(-1);
    // It has to run before anything is written, not after.
    expect(guardIndex).toBeLessThan(APPLY_ASSIGNMENT.indexOf('inspectionAssignment.create'));
  });

  it('reads the current assignment before deciding rather than after', () => {
    // The old order looked up `current` only once a match had been resolved,
    // which is why the status check had to stand in for "is anyone assigned".
    expect(APPLY_ASSIGNMENT.indexOf('inspectionAssignment.findFirst')).toBeLessThan(
      APPLY_ASSIGNMENT.indexOf('resolveAssignment('),
    );
  });

  it('still refuses to reassign to the technician already on the inspection', () => {
    // Otherwise every pass writes an identical assignment row and an audit
    // entry saying the technician changed, when nothing did.
    expect(APPLY_ASSIGNMENT).toContain(
      'if (current?.technicianId === resolution.match.technicianId) return;',
    );
  });

  it('still names nobody as the assigner', () => {
    // No person here made this call. See the column comment on
    // InspectionAssignment.assignedById.
    expect(APPLY_ASSIGNMENT).toContain('assignedById: null');
  });

  it('still records an unrecognised assignee rather than guessing one', () => {
    // Half the assignees on a live calendar are not technicians in this app.
    // Approximating one would put the wrong name against finished work.
    expect(APPLY_ASSIGNMENT).toContain('unknownAssigneeReason(resolution.misses)');
  });
});
