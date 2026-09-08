import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two report rows that mean the same thing.
 *
 * `resolveChecklistItem` matches on the label, so a report carrying two
 * differently-worded lines for one item — and real ones do — resolves both to
 * the same `AreaChecklistItem`. Creating a response for each violated
 * `@@unique([inspectionAreaId, checklistItemId])`, and because the write runs
 * inside a transaction it took the **entire import** down with it.
 *
 * 1547 Revolution Way failed exactly this way in production: fifteen areas and
 * 185 photographs rolled back over one duplicated row, and the inspection was
 * left showing nothing at all. It is the same shape as the area-attachment bug
 * fixed in #135, one table over.
 */

const SERVICE = readFileSync(
  join(__dirname, '..', 'src', 'admin', 'inspection-import', 'inspection-import.service.ts'),
  'utf8',
);

describe('a report row that repeats an item', () => {
  it('looks for an existing response before creating one', () => {
    const write = SERVICE.slice(
      SERVICE.indexOf('const existingResponse ='),
      SERVICE.indexOf('for (const photo of area.photos)'),
    );
    expect(write).toContain('inspectionAreaChecklistResponse.findUnique');
    expect(write).toContain('inspectionAreaId_checklistItemId');
    // Both branches present: an update when it is there, a create when it is not.
    expect(write).toContain('inspectionAreaChecklistResponse.update');
    expect(write).toContain('inspectionAreaChecklistResponse.create');
  });

  it('keeps the worse grading when two rows disagree', () => {
    // The direction matters. A recorded defect losing to a later pass deletes a
    // real finding, and a move-out is compared against these. A pass losing to
    // a defect is only an over-report, which a reviewer can see and correct.
    expect(SERVICE).toContain('function worseOf(');
    const worse = SERVICE.slice(SERVICE.indexOf('function worseOf('), SERVICE.indexOf('function joinComments('));
    expect(worse).toContain('if (left === false || right === false) return false;');
    // An unanswered row must never overwrite an answered one: null means the
    // inspector did not look, which is not the same as "it was fine".
    expect(worse).toContain('if (left === true || right === true) return true;');
    // Falls through to null: neither row answered, so neither claims one.
    expect(worse).toContain('return null;');
  });

  it('keeps both comments rather than choosing one', () => {
    expect(SERVICE).toContain('function joinComments(');
    const join = SERVICE.slice(
      SERVICE.indexOf('function joinComments('),
      SERVICE.indexOf('/** Where the uploaded report itself is kept'),
    );
    // De-duplicated, so a row repeated verbatim reads as one comment rather
    // than the same sentence twice.
    expect(join).toContain('new Set(parts)');
  });

  it('still records a blank row as unanswered, not as a pass', () => {
    // The rule this import has always followed: storing false where the report
    // left a row blank would turn "the inspector did not look" into "it
    // failed", and a move-out would be compared against a defect nobody wrote.
    const create = SERVICE.slice(
      SERVICE.indexOf('await tx.inspectionAreaChecklistResponse.create({'),
      SERVICE.indexOf('for (const photo of area.photos)'),
    );
    expect(create).toContain('isClean: item.isClean');
    expect(create).not.toContain('isClean: item.isClean ?? false');
  });
});
