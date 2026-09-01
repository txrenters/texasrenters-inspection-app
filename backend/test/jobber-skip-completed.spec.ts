import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The completed-visit skip is a few lines inside the sync worker, and its
 * correctness is entirely about *where* those lines sit. Asserting on the
 * source is blunt, but the alternative — standing up the whole worker with a
 * Prisma double — would test the mock rather than the ordering that matters.
 */
const WORKER = readFileSync(
  join(__dirname, '..', 'src', 'workers', 'jobber-sync', 'jobber-sync.worker.ts'),
  'utf8',
);

describe('skipping visits Jobber has already completed', () => {
  it('checks completion after the already-imported branch', () => {
    // Order is the whole point. A visit completed *since* we created its
    // inspection must keep that inspection and its link — the work is real and
    // may still be under review here. Checking completion first would strip the
    // inspectionId off every one of them.
    const importedBranch = WORKER.indexOf('JobberVisitImportStatus.IMPORTED');
    const completedSkip = WORKER.indexOf('SKIPPED_COMPLETE');
    expect(importedBranch).toBeGreaterThan(-1);
    expect(completedSkip).toBeGreaterThan(importedBranch);
  });

  it('treats a completedAt timestamp as authoritative, not just the status label', () => {
    // visitStatus is a derived label and Jobber may add values to that enum;
    // completedAt is a fact. Both are accepted, so neither alone can let
    // finished work through.
    expect(WORKER).toMatch(/visit\.completedAt\s*\|\|\s*visit\.visitStatus === 'COMPLETED'/);
  });

  it('records them rather than dropping them, so a history view is possible', () => {
    expect(WORKER).toMatch(/status: JobberVisitImportStatus\.SKIPPED_COMPLETE/);
    // Not counted as a failure: nothing is wrong with a finished visit.
    expect(WORKER).toMatch(/result\.alreadyComplete \+= 1/);
  });
});
