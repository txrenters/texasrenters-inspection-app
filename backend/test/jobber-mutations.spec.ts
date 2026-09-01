import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Mutation names and argument shapes, pinned against what the live schema
 * actually offers.
 *
 * Both were wrong when first written, and neither could fail visibly: the push
 * only runs when an inspection is finalized, and nothing had been. `updatedAt`
 * on the query broke loudly on the first sync; these would have waited until
 * somebody signed off real work.
 *
 * Verified 2026-09-01 by introspection against JOBBER_API_VERSION 2025-01-20:
 *   visitComplete(visitId: EncodedId!, input: VisitCompleteInput)
 *   VisitCompleteInput { completedAt: ISO8601DateTime }
 *   jobCreateNote(jobId: EncodedId!, input: JobCreateNoteInput!)
 */
const QUERIES = readFileSync(
  join(__dirname, '..', 'src', 'integrations', 'jobber', 'jobber.queries.ts'),
  'utf8',
);

describe('Jobber mutation shapes', () => {
  it('creates a job note with the name Jobber actually has', () => {
    expect(QUERIES).toContain('jobCreateNote(jobId: $jobId, input: $input)');
    // The name that does not exist. Every report-link push failed on it.
    expect(QUERIES).not.toMatch(/jobNoteCreate\(/);
  });

  it('passes the note body as an input object, not a bare message argument', () => {
    expect(QUERIES).toMatch(/\$input: JobCreateNoteInput!/);
  });

  it('sends a completion time with visitComplete', () => {
    expect(QUERIES).toMatch(/\$input: VisitCompleteInput/);
    expect(QUERIES).toContain('visitComplete(visitId: $visitId, input: $input)');
  });

  it('selects userErrors on both, since Jobber rejects inside a 200', () => {
    // Counted from actual declarations, not the word: the doc comments discuss
    // mutations and userErrors at length, and would inflate a naive count.
    const declarations = QUERIES.match(/mutation \w+\(/g) ?? [];
    expect(declarations).toHaveLength(2);

    const visit = QUERIES.slice(
      QUERIES.indexOf('VISIT_COMPLETE_MUTATION'),
      QUERIES.indexOf('JOB_NOTE_CREATE_MUTATION'),
    );
    const note = QUERIES.slice(QUERIES.indexOf('JOB_NOTE_CREATE_MUTATION'));
    for (const body of [visit, note]) expect(body).toContain('userErrors');
  });
});
