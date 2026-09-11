import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An import replaces what it finds.
 *
 * It used to refuse an inspection holding anything, which read as caution and
 * was the opposite: an import is what the office reaches for when the record
 * here is *wrong*, so refusing to overwrite refused the case that mattered.
 * 10051 Spotted Horse Dr is the example — two test rooms invented on a property
 * layout, snapshotted onto every inspection there, undeletable through the
 * property screen while an inspection referenced them, and un-importable
 * because the inspection was not empty.
 *
 * Replacing is destructive, so the *order* it happens in is the whole safety
 * argument, and none of it is observable from the outside: the writes live
 * inside one transaction against a live database. So this reads the source, the
 * way the duplicate-row spec next door does.
 */

const SERVICE = readFileSync(
  join(__dirname, '..', 'src', 'admin', 'inspection-import', 'inspection-import.service.ts'),
  'utf8',
);

/**
 * The commit, from the read of what it will supersede to the line that says it
 * happened.
 *
 * Both ends searched *forwards from the start*, because the obvious end anchors
 * are not unique: every phase of an import updates its job row, so an
 * `indexOf` for that found an earlier one and sliced this to nothing — six
 * assertions passing against an empty string.
 */
const COMMIT_START = SERVICE.indexOf('const superseded: Array<{ storageKey: string }> =');
const COMMIT = SERVICE.slice(
  COMMIT_START,
  SERVICE.indexOf("event: 'inspection_report_imported'", COMMIT_START),
);

it('found the commit to read', () => {
  // The guard the above needed. A slice that silently comes back empty makes
  // every `toContain` below fail at once and none of them mean anything.
  expect(COMMIT_START).toBeGreaterThan(-1);
  expect(COMMIT.length).toBeGreaterThan(500);
});

describe('an import over an inspection that already holds evidence', () => {
  it('clears the prior photographs and grades inside the transaction', () => {
    // Inside, so a failed import leaves the old evidence exactly where it was.
    // This commit rolls back for a living — one duplicated checklist row took a
    // fifteen-area import down — and clearing outside the transaction would
    // make each of those failures destroy the walkthrough it failed to replace.
    const tx = COMMIT.slice(COMMIT.indexOf('$transaction'));
    expect(tx).toContain('tx.inspectionPhoto.deleteMany');
    expect(tx).toContain('tx.inspectionAreaChecklistResponse.deleteMany');
  });

  it('clears them before writing the new report, not after', () => {
    // Order, not presence. Deleting after the write would take the import's own
    // photographs straight back out again.
    const clear = COMMIT.indexOf('tx.inspectionPhoto.deleteMany');
    const write = COMMIT.indexOf('for (const area of report.areas)');
    expect(clear).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(clear);
  });

  it('scopes the clearing to this inspection alone', () => {
    // A `deleteMany` is only as safe as its `where`. Responses hang off areas
    // rather than the inspection, so theirs has to travel through the relation.
    const photos = COMMIT.slice(COMMIT.indexOf('tx.inspectionPhoto.deleteMany'));
    expect(photos.slice(0, 200)).toContain('inspectionId: inspection.id');
    const responses = COMMIT.slice(COMMIT.indexOf('tx.inspectionAreaChecklistResponse.deleteMany'));
    expect(responses.slice(0, 200)).toContain('inspectionArea: { inspectionId: inspection.id }');
  });

  it('drops rooms the new report does not mention', () => {
    // The Spotted Horse case: a report that does not mention a room is the
    // office saying that room is not part of this walkthrough. Without this the
    // test areas survive every import and stay undeletable.
    expect(COMMIT).toContain('touched.add(inspectionArea.id)');
    const stale = COMMIT.slice(COMMIT.indexOf('const stale ='));
    expect(stale).toContain('id: { notIn: [...touched] }');
  });

  it('keeps a room that holds a recording', () => {
    /**
     * Two reasons, either sufficient.
     *
     * A video is the one piece of evidence a PDF cannot put back. And
     * `InspectionMedia.inspectionArea` restricts rather than cascades, so
     * deleting such an area throws *inside* the transaction and takes the whole
     * import with it — a room with a recording would fail every future import
     * of that inspection rather than being skipped.
     */
    const stale = COMMIT.slice(COMMIT.indexOf('const stale ='));
    expect(stale.slice(0, 400)).toContain('media: { none: {} }');
  });

  it('clears the restricting children of a stale room before deleting it', () => {
    // Status history and upload sessions restrict too. Photographs, checklist
    // responses and evidence requests cascade, so those are not listed here —
    // and adding a new restricting child to `InspectionArea` without adding it
    // here is what would break this next.
    const stale = COMMIT.slice(COMMIT.indexOf('const staleIds ='));
    const history = stale.indexOf('tx.inspectionAreaStatusHistory.deleteMany');
    const sessions = stale.indexOf('tx.mediaUploadSession.deleteMany');
    const area = stale.indexOf('tx.inspectionArea.deleteMany');
    expect(history).toBeGreaterThan(-1);
    expect(sessions).toBeGreaterThan(-1);
    expect(area).toBeGreaterThan(sessions);
    expect(sessions).toBeGreaterThan(history);
  });

  it('deletes the superseded objects only after the transaction commits', () => {
    // The rows come back inside the transaction; the objects behind them do
    // not. An orphaned object costs storage, while deleting one for a
    // transaction that then rolled back destroys a photograph nothing replaced.
    // Same order `TechnicianService.deletePhoto` uses.
    const read = SERVICE.indexOf('const superseded: Array<{ storageKey: string }> =');
    const commit = SERVICE.indexOf('const inspectionId = await this.prisma.$transaction(');
    const purge = SERVICE.indexOf('superseded.map((photo) => this.storage.delete(');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(commit);
    expect(purge).toBeGreaterThan(commit);
    // Best-effort: a storage failure must not fail an import that has already
    // been written and committed.
    expect(SERVICE.slice(purge, purge + 200)).toContain('catch(() => undefined)');
  });

  it('counts what it overwrote into the audit row', () => {
    // The import writes through `finalizedAt`, which freezes evidence
    // everywhere else in this system. That is deliberate and was asked for — so
    // what makes it acceptable is that the replacement is answerable
    // afterwards, not silent.
    const audit = SERVICE.slice(SERVICE.indexOf("action: 'INSPECTION_REPORT_IMPORTED'"));
    const replaced = audit.slice(audit.indexOf('replaced:'), audit.indexOf('return inspection.id'));
    expect(replaced).toContain('photos: replacedPhotos.count');
    expect(replaced).toContain('checklistResponses: replacedResponses.count');
    expect(replaced).toContain('areas: staleIds.length');
  });

  it('no longer refuses an inspection for holding evidence', () => {
    // The guard this replaced. Left as an assertion because re-adding it would
    // silently restore the block the office asked to have removed.
    expect(SERVICE).not.toContain('INSPECTION_NOT_EMPTY');
  });
});

/**
 * The second report.
 *
 * An agent who submits an incomplete walkthrough issues another PDF covering
 * what was missed. Under REPLACE that file would delete every area the first
 * one established and keep only the garage, so ADD exists -- and because it
 * shares this destructive commit, what it must *not* do is the part worth
 * pinning down.
 */
describe('an additional report, imported with ADD', () => {
  const tx = COMMIT.slice(COMMIT.indexOf('$transaction'));

  it('does not clear the whole inspection', () => {
    // The bulk clears belong to REPLACE. Under ADD an area this report never
    // mentions keeps the evidence the first report gave it.
    expect(tx).toContain("mode === 'REPLACE'");
    const bulkPhotos = tx.indexOf('tx.inspectionPhoto.deleteMany({ where: { inspectionId:');
    expect(bulkPhotos).toBeGreaterThan(-1);
    expect(tx.slice(0, bulkPhotos)).toContain("mode === 'REPLACE'");
  });

  it('drops no area it simply does not mention', () => {
    // The stale sweep is what would delete the kitchen when the second report
    // only covers the garage. Its silence about a room says nothing about it.
    const stale = tx.slice(tx.indexOf('const stale ='));
    expect(stale).toContain("mode === 'REPLACE'");
    expect(stale).toContain(': [];');
  });

  it('replaces only the areas it does cover, per area', () => {
    const perArea = tx.slice(tx.indexOf("if (mode === 'ADD')"));
    expect(perArea).toContain('tx.inspectionAreaChecklistResponse.deleteMany');
    expect(perArea).toContain('inspectionAreaId: inspectionArea.id');
  });

  /**
   * The trap. Storage objects are deleted after the commit, and under ADD most
   * of them belong to areas being kept — removing those files while their rows
   * survive leaves the first report's areas pointing at nothing, which reads as
   * corrupt evidence rather than a missing file.
   */
  it('supersedes only the storage objects it actually replaced', () => {
    const perArea = tx.slice(tx.indexOf("if (mode === 'ADD')"));
    const collect = perArea.indexOf('superseded.push(');
    const remove = perArea.indexOf('tx.inspectionPhoto.deleteMany');
    expect(collect).toBeGreaterThan(-1);
    // Read before the delete, or there is nothing left to read.
    expect(perArea.indexOf('tx.inspectionPhoto.findMany')).toBeLessThan(remove);
    expect(perArea).toContain('inspectionAreaId: inspectionArea.id');
  });

  it('records which way the report was written', () => {
    // "replaced.areas: 0" means something different under each mode.
    expect(COMMIT).toContain('mode,');
  });
});
