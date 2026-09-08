import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Closing an inspection the technician never submitted.
 *
 * `finalizeInspection` is the end of the review workflow and only accepts an
 * inspection that entered it — submitted, under review, TBD, follow-up. That
 * left no way to close a SCHEDULED one, and those exist in numbers: the walk
 * happened in Inspect & Cloud, the evidence arrives by import, and no
 * technician ever touched the record here. The office could import a report and
 * then watch the inspection sit as "Scheduled" for ever.
 *
 * The distinction this pins down is completion versus finalization.
 * `finalizedAt` freezes evidence permanently — photograph deletion and area
 * renaming both key on it — and this action is a scheduling correction, not a
 * sign-off on evidence nobody has reviewed. Setting it here would quietly
 * destroy the ability to review the very report that was just imported.
 */

const SERVICE = readFileSync(
  join(__dirname, '..', 'src', 'admin', 'admin.service.ts'),
  'utf8',
);
const CONTROLLER = readFileSync(
  join(__dirname, '..', 'src', 'admin', 'admin.controller.ts'),
  'utf8',
);
const DTO = readFileSync(join(__dirname, '..', 'src', 'admin', 'admin.dto.ts'), 'utf8');

const COMPLETE = SERVICE.slice(
  SERVICE.indexOf('async completeInspection'),
  SERVICE.indexOf('async finalizeInspection'),
);

describe('marking an inspection complete by hand', () => {
  it('completes without finalizing', () => {
    // The whole point. `finalizedAt` freezes evidence, and nobody here has
    // reviewed any of it — the walkthrough happened in another system.
    expect(COMPLETE).toContain('status: InspectionStatus.COMPLETED');
    expect(COMPLETE).toContain('completedAt: new Date()');
    expect(COMPLETE).not.toContain('finalizedAt');
    expect(COMPLETE).not.toContain('finalizedById');
  });

  it('does not require the technician to have submitted anything', () => {
    // `assertReviewable` is what refuses a SCHEDULED inspection, and it is the
    // reason this method exists at all. Calling it here would reintroduce the
    // gap.
    expect(COMPLETE).not.toContain('assertReviewable');
  });

  it('refuses an inspection that is already closed', () => {
    // Completing a completed inspection would move `completedAt` for no
    // reason; completing a cancelled one would revive it by the back door.
    expect(COMPLETE).toContain('FROZEN_INSPECTION_STATUSES.includes');
    expect(COMPLETE).toContain('INSPECTION_ALREADY_CLOSED');
  });

  it('clears the holds that were keeping it open', () => {
    expect(COMPLETE).toContain('completionBlockedReason: null');
    expect(COMPLETE).toContain('tbdReason: null');
  });

  it('records why, and says the review workflow was skipped', () => {
    // This bypasses submit and review, so the audit row is the only record of
    // why. `finalized: false` stops a later reader mistaking it for a sign-off.
    expect(COMPLETE).toContain("'INSPECTION_COMPLETED_BY_ADMIN'");
    expect(COMPLETE).toContain('reason: input.reason');
    expect(COMPLETE).toContain('previousStatus: existing.status');
    expect(COMPLETE).toContain('finalized: false');
  });

  it('requires the reason rather than accepting a blank one', () => {
    // Bounded to the class body: a fixed-length slice runs into the next class
    // and picks up its decorators, which is how this test first passed for the
    // wrong reason.
    const start = DTO.indexOf('export class CompleteInspectionDto');
    const dto = DTO.slice(start, DTO.indexOf('}', start));
    expect(dto).toContain('@IsString()');
    expect(dto).toContain('@MinLength(2)');
    expect(dto).not.toContain('@IsOptional()');
  });

  it('is gated on inspections:finalize, not inspections:manage', () => {
    // It ends the work, which is the same class of decision as finalizing —
    // even though it deliberately does not freeze the evidence.
    const route = CONTROLLER.slice(
      CONTROLLER.indexOf("@Post('inspections/:inspectionId/complete')"),
      CONTROLLER.indexOf("@Post('inspections/:inspectionId/finalize')"),
    );
    expect(route).toContain("@RequirePermissions('inspections:finalize')");
  });

  it('says nothing about inspection type', () => {
    // Nothing here is type-specific, and a restriction would recreate the gap
    // one type at a time.
    expect(COMPLETE).not.toContain('InspectionType.');
  });
});
