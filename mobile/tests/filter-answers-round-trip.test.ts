import {
  filterAnswered,
  filterRows,
  nextFilterSlot,
  withAddedFilter,
  withFilterAnswer,
} from '../src/utils/job-tasks';

/**
 * The AC filter change, as the office found it on 2026-09-23.
 *
 * "I add a filter but still it fails silently it won't add", and "when I take a
 * picture there's no indicator that we have added a photo of how many". Both
 * were real, and neither was the slot collision fixed the day before — that fix
 * was in the build they were running.
 *
 * What these pin is the shape of the answers, because the failure was that the
 * phone and the server stopped agreeing about them.
 */

const DETAILS = 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection';

describe('a filter the technician found on site', () => {
  /**
   * Adding one used to go through `withFilterAnswer` as
   * `{ changed: false, reason: 'Found on site' }`, so the new card drew itself
   * with a red cross reading "Not changed" — which is what a refusal looks
   * like, in answer to a successful add.
   */
  it('is added outstanding, not refused', () => {
    const report = withAddedFilter(null, { size: '16x20x1', location: null, slot: 1 });

    const added = report.filters![0]!;
    expect(added).toMatchObject({ size: '16x20x1', changed: false, reason: null, booked: false });
    expect(filterAnswered(added)).toBe(false);
  });

  /**
   * `withFilterAnswer` ticks the whole AC filter change done, which is right
   * for an answer and wrong for merely finding a register: it claimed the
   * service had been carried out before anything was photographed, and on the
   * ~130 properties whose visit lists no sizes that is the entire workflow.
   */
  it('does not claim the filter change was done', () => {
    const report = withAddedFilter(null, { size: '16x20x1', location: null, slot: 1 });

    expect(report.services.filterChange).toBeUndefined();
  });

  it('shows up as a row to photograph', () => {
    const report = withAddedFilter(null, { size: '16x20x1', location: 'attic', slot: 1 });

    const rows = filterRows(DETAILS, report);
    const found = rows.find((row) => row.filter.size === '16x20x1');
    expect(found).toBeDefined();
    expect(found!.answer?.booked).toBe(false);
  });

  /** Twice is once: the Add sheet can be tapped again before the save lands. */
  it('is not added twice', () => {
    const once = withAddedFilter(null, { size: '16x20x1', location: null, slot: 1 });
    const twice = withAddedFilter(once, { size: '16x20x1', location: null, slot: 1 });

    expect(twice.filters).toHaveLength(1);
  });

  /**
   * The slot rule from the day before, kept: a register matching one the visit
   * already lists takes the next free slot rather than answering that one.
   */
  it('takes the next free slot when the visit already lists its size', () => {
    expect(nextFilterSlot(DETAILS, null, { size: '20x25x1', location: null })).toBe(2);
  });
});

describe('what counts as answered', () => {
  const register = { size: '20x25x1', location: null, slot: 1 };

  it('is not merely having been added', () => {
    expect(filterAnswered(withAddedFilter(null, register).filters![0])).toBe(false);
  });

  it('is a register photographed', () => {
    const report = withFilterAnswer(null, register, { changed: true, photoKey: 'snapshot-1' });
    expect(filterAnswered(report.filters![0])).toBe(true);
  });

  /**
   * The counter read "0 of 3 done" over three answered cards, because it
   * counted only registers that were *changed*. A filter honestly reported as
   * not changed — no access, wrong size brought — is answered.
   */
  it('is a register refused with a reason', () => {
    const report = withFilterAnswer(null, register, { changed: false, reason: 'Cupboard locked' });
    expect(filterAnswered(report.filters![0])).toBe(true);
  });
});

describe('a photographed register', () => {
  /**
   * The photograph is held on the device for a review window before it
   * uploads, so for that whole time the handset's own key is the only evidence
   * the shot exists. The phone's response schema did not name `photoKey`, zod
   * stripped it from the server's reply, and the row fell back to "Not done
   * yet" over a filter that had just been photographed.
   */
  it('keeps the handset key that is all it has before the upload lands', () => {
    const report = withFilterAnswer(
      null,
      { size: '20x25x1', location: null, slot: 1 },
      { changed: true, photoKey: 'snapshot-1' },
    );

    const answer = report.filters![0]!;
    expect(answer.photoKey).toBe('snapshot-1');
    expect(answer.photoId).toBeNull();
  });

  /**
   * And keeps it through the next answer. This is how the evidence was
   * destroyed: the second save round-tripped the first register back with no
   * key, the server wrote null over it, and the photograph arriving afterwards
   * had nothing left to attach to.
   */
  it('still has it after another register is answered', () => {
    const first = withFilterAnswer(
      null,
      { size: '20x25x1', location: null, slot: 1 },
      { changed: true, photoKey: 'snapshot-1' },
    );
    const second = withFilterAnswer(
      first,
      { size: '16x20x1', location: null, slot: 1 },
      { changed: true, photoKey: 'snapshot-2' },
    );

    expect(second.filters!.map((filter) => filter.photoKey)).toEqual(['snapshot-1', 'snapshot-2']);
  });
});
