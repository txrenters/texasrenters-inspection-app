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

  /**
   * Verified 2026-09-11 by introspection against the same API version:
   *   visitCreate(jobId: EncodedId, input: VisitCreateInput): VisitCreatePayload
   *   VisitCreateInput      { visits: [VisitCreateAttributes]! }
   *   VisitCreateAttributes { title, instructions, overrideOrder, schedule }
   *   VisitCreatePayload    { createdVisits, job, userErrors }
   */
  it('books a visit with the name and payload Jobber actually has', () => {
    expect(QUERIES).toContain('visitCreate(jobId: $jobId, input: $input)');
    expect(QUERIES).toMatch(/\$input: VisitCreateInput!/);
    // `createdVisits`, plural — the payload returns a list, and reading it as a
    // single `visit` would come back undefined and lose the new id.
    expect(QUERIES).toMatch(/createdVisits\s*\{/);
    expect(QUERIES).not.toMatch(/visitCreate\([^)]*\)\s*\{\s*visit\s*\{/);
  });

  it('selects userErrors on every mutation, since Jobber rejects inside a 200', () => {
    // Counted from actual declarations, not the word: the doc comments discuss
    // mutations and userErrors at length, and would inflate a naive count.
    const declarations = QUERIES.match(/mutation \w+\(/g) ?? [];
    expect(declarations).toHaveLength(4);

    // Sliced between the constants in the order they appear, so a mutation
    // added between two others is checked rather than folded into a neighbour.
    const names = [
      'VISIT_COMPLETE_MUTATION',
      'VISIT_CREATE_MUTATION',
      'JOB_CREATE_MUTATION',
      'JOB_NOTE_CREATE_MUTATION',
    ];
    const bounds = names
      .map((name) => ({ name, at: QUERIES.indexOf(`export const ${name}`) }))
      .sort((left, right) => left.at - right.at);

    for (const [index, entry] of bounds.entries()) {
      const end = bounds[index + 1]?.at ?? QUERIES.length;
      expect(QUERIES.slice(entry.at, end)).toContain('userErrors');
    }
  });
});
