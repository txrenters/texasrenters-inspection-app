import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A report is written in as soon as it is read.
 *
 * Importing used to stop after the read and wait for somebody to open the
 * report, look at what it found and press Import. That step cost eleven
 * inspections: every one uploaded, parsed, and left showing zero areas, zero
 * photographs and nothing to compare against — because the person who started
 * it had moved to the next property and nothing brought them back.
 *
 * The check it performed is not lost, only unblocked. The parse is
 * deterministic and reconciles exactly on a known layout, what it could not
 * resolve is still recorded on the job, and the import still lands *under
 * review rather than finalized* — so a human signs off before anything reaches
 * a charge, which is the guarantee the gate was really there for.
 *
 * Asserted against the source. What matters is the ordering and the guards that
 * survive it, and reading the order they are written in says that more plainly
 * than mocking a Prisma client through two detached promises.
 */

const SERVICE = readFileSync(
  join(__dirname, '..', 'src', 'admin', 'inspection-import', 'inspection-import.service.ts'),
  'utf8',
);

const EXTRACTION = SERVICE.slice(
  SERVICE.indexOf('private async runExtraction'),
  SERVICE.indexOf('private async applyRead'),
);

const APPLY = SERVICE.slice(
  SERVICE.indexOf('private async applyRead'),
  SERVICE.indexOf('private async fail('),
);

describe('applying a report without being asked', () => {
  it('commits as soon as the read has been recorded', () => {
    // Order matters: the job has to be COMPLETED with its output stored before
    // the commit runs, because `commit` refuses a job that is not.
    const statusWritten = EXTRACTION.indexOf("status: 'COMPLETED'");
    const applied = EXTRACTION.indexOf('this.applyRead(');
    expect(statusWritten).toBeGreaterThan(-1);
    expect(applied).toBeGreaterThan(statusWritten);
  });

  it('does not apply a read that failed', () => {
    // `fail` returns before ever reaching the apply, so an unreadable report
    // stays unreadable rather than committing nothing over an inspection.
    const aiFailure = EXTRACTION.slice(
      EXTRACTION.indexOf('if (!read.report)'),
      EXTRACTION.indexOf('report = read.report;'),
    );
    expect(aiFailure).toContain('return;');
    expect(aiFailure).not.toContain('applyRead');
  });

  it('goes through the same commit the console calls', () => {
    // Not a second write path. The guards that matter — the inspection must be
    // empty, it must have a property, the same report must not already be
    // imported — live in `commit`, and duplicating them here is how two
    // versions of a rule start disagreeing.
    expect(APPLY).toContain('await this.commit(user, jobId);');
  });

  it('records a refusal instead of rejecting into nothing', () => {
    // This runs on a detached promise with nobody listening. An ApplicationError
    // thrown here would be an unhandled rejection rather than something a
    // reader ever sees, so it becomes a failed job carrying the reason.
    expect(APPLY).toContain('catch');
    expect(APPLY).toContain('ApplicationError');
    expect(APPLY).toContain('await this.fail(jobId, code);');
    expect(APPLY).toContain('inspection_import_auto_apply_failed');
  });

  it('still does not finalize what it writes', () => {
    // The whole safety argument for applying automatically: evidence arrives
    // under review, so a human still signs off before it can reach a charge.
    //
    // Scoped to the write itself rather than the file — `finalizedAt` appears
    // twice in prose explaining why it is left alone, and a whole-file search
    // matches the explanation instead of the behaviour.
    const write = SERVICE.slice(
      SERVICE.indexOf('await tx.inspection.update({'),
      SERVICE.indexOf('const inspection = { id: target.id };'),
    );
    expect(write).toContain('source: InspectionSource.IMPORTED_REPORT');
    expect(write).not.toContain('finalizedAt');
    expect(write).not.toContain('status:');
  });

  it('tells the console nothing is waiting on a person', () => {
    // `awaitingReview` used to mean "read, and parked until somebody acts".
    // Nothing parks any more, and leaving it true would recreate the queue of
    // reports the console asked people to come back to.
    const running = SERVICE.slice(
      SERVICE.indexOf('async runningJobs'),
      SERVICE.indexOf('async activeJob'),
    );
    expect(running).toContain('awaitingReview: false');
  });

  it('names the outcome, so a notification can be true', () => {
    // A row leaving the list means written in, or it means failed. Announcing
    // success on a disappearance would be a cheerful lie.
    const running = SERVICE.slice(
      SERVICE.indexOf('async runningJobs'),
      SERVICE.indexOf('async activeJob'),
    );
    expect(running).toContain("'FAILED' as const");
    expect(running).toContain("'IMPORTED' as const");
    expect(running).toContain("'READING' as const");
  });
});
