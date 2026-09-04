import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Recovering a move-in that was walked before we ever saw it.
 *
 * Jobber closes a move-in when the visit completes, and the walkthrough itself
 * happens in Inspect & Cloud — so the only trace reaching this system is a
 * finished visit, which the sync skipped along with every other finished visit.
 * Eight of them sat in `SKIPPED_COMPLETE`, and each one is a baseline a later
 * move-out has nothing to compare against.
 *
 * The skip itself is right and stays: of the 130 finished visits, 47 are filter
 * deliveries and 77 carry a job number for a title and no type at all.
 * Importing those would invent history rather than recover it.
 *
 * Asserted against the worker source. The decision is an ordering between four
 * branches in one method, and the thing worth pinning is which branch wins —
 * something no amount of mocking Prisma demonstrates more clearly than reading
 * the order it is written in.
 */

const WORKER = readFileSync(
  join(__dirname, '..', 'src', 'workers', 'jobber-sync', 'jobber-sync.worker.ts'),
  'utf8',
);

const CREATION = readFileSync(
  join(__dirname, '..', 'src', 'admin', 'inspection-creation.ts'),
  'utf8',
);

describe('which finished visits are recovered', () => {
  it('recovers only a move-in', () => {
    // The narrowness is the safety. A filter delivery or an untyped job number
    // has no baseline to be, and creating one would be fabricating a
    // walkthrough that never happened here.
    const guard = WORKER.slice(
      WORKER.indexOf('const isRecoverableMoveIn'),
      WORKER.indexOf('if (isComplete && !isRecoverableMoveIn)'),
    );
    expect(guard).toContain('InspectionType.MOVE_IN');
    expect(guard).not.toContain('OCCUPIED');
    expect(guard).not.toContain('MOVE_OUT');
  });

  it('requires a property and a date before recovering anything', () => {
    // Without either, the visit would fall through to the reject and hold
    // branches below and change status for finished work that used to be left
    // alone. It stays skipped instead.
    const guard = WORKER.slice(
      WORKER.indexOf('const isRecoverableMoveIn'),
      WORKER.indexOf('if (isComplete && !isRecoverableMoveIn)'),
    );
    expect(guard).toContain('visit.property?.id');
    expect(guard).toContain('visit.startAt');
  });

  it('still skips every other finished visit', () => {
    expect(WORKER).toContain('JobberVisitImportStatus.SKIPPED_COMPLETE');
    expect(WORKER).toContain('result.alreadyComplete += 1');
  });
});

describe('what a recovered move-in is recorded as', () => {
  it('is COMPLETED, so it cannot reach a technician', () => {
    // The concern the original skip was written for, in its own words: turning
    // finished visits into inspections "would put jobs on a technician's phone
    // that somebody already did". The technician queue is SCHEDULED and
    // IN_PROGRESS only, so COMPLETED is what answers it.
    const insert = WORKER.slice(WORKER.indexOf('const inspection = await insertInspection'));
    expect(insert).toContain('InspectionStatus.COMPLETED');
    expect(insert).toContain('isComplete');
  });

  it('carries the moment Jobber says the work finished', () => {
    const insert = WORKER.slice(WORKER.indexOf('const inspection = await insertInspection'));
    expect(insert).toContain('visit.completedAt');
  });

  it('leaves every other caller of insertInspection exactly as it was', () => {
    // Spread, not assigned: a caller that passes neither field must still get
    // the column defaults it got before this existed.
    expect(CREATION).toContain('...(details.status ? { status: details.status } : {})');
    expect(CREATION).toContain('...(details.completedAt ? { completedAt: details.completedAt } : {})');
  });
});

describe('the ordering the mapping queue depends on', () => {
  it('types the visit before resolving its property', () => {
    // Unchanged by this work and worth re-pinning, because the type resolution
    // moved. Resolving the property first put filter deliveries into the
    // mapping queue — the console listing properties to map on behalf of work
    // it was never going to import.
    const type = WORKER.indexOf('resolveVisitType(visit.title, rules)');
    const property = WORKER.indexOf('await this.mapping.resolveProperty(');
    expect(type).toBeGreaterThan(-1);
    expect(property).toBeGreaterThan(type);
  });

  it('decides the finished case before the property and date checks', () => {
    // So a finished visit that is not a recoverable move-in is skipped rather
    // than rejected, which is what it was before.
    const complete = WORKER.indexOf('if (isComplete && !isRecoverableMoveIn)');
    const noProperty = WORKER.indexOf("'JOBBER_VISIT_HAS_NO_PROPERTY'");
    expect(complete).toBeGreaterThan(-1);
    expect(noProperty).toBeGreaterThan(complete);
  });
});
