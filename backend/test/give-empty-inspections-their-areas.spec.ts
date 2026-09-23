import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Giving a scheduled inspection the rooms it was created without.
 *
 * The script adds rooms to somebody's job, so the boundaries it keeps are the
 * whole of its safety: only scheduled visits, only rooms, through the service
 * that audits and notifies rather than straight into the table.
 *
 * Pinned by reading the source because the script boots the real application
 * against a real database — there is nothing to unit test without standing one
 * up, and a test that stood one up would be testing Nest.
 */

const source = readFileSync(
  join(__dirname, '..', 'scripts', 'give-empty-inspections-their-areas.mjs'),
  'utf8',
);

describe('giving empty inspections their areas', () => {
  /**
   * A completed or cancelled visit's areas are the record of what was walked.
   * Adding rooms to one rewrites history for a report that may already have
   * been issued and charged against a deposit.
   */
  it('only touches scheduled visits', () => {
    expect(source).toContain("status: 'SCHEDULED'");
    expect(source).toContain('finalizedAt: null');
  });

  /** An HVAC visit's subjects are not rooms; the server would refuse them. */
  it('gives rooms, using the same rule the server scopes with', () => {
    expect(source).toContain('layoutAreasFor(onTheProperty)');
  });

  it('leaves the visits that resolve their own subjects alone', () => {
    const walks = /const ROOM_WALKS = \[([^\]]*)\]/.exec(source)?.[1] ?? '';

    expect(walks).toContain('OCCUPIED');
    expect(walks).not.toContain('HVAC');
    expect(walks).not.toContain('ROOF');
  });

  /**
   * Through the service, not the table. That is what gets the same refusals
   * the console gets, the audit row, and the push to the technician's handset.
   */
  it('goes through addInspectionAreas rather than inserting rows', () => {
    expect(source).toContain('admin.addInspectionAreas(');
    expect(source).not.toContain('inspectionArea.createMany');
  });

  /** The audit has to name a person who exists, not a guess. */
  it('refuses a real run with nobody to name in the audit', () => {
    expect(source).toContain("if (apply && !actorId) throw new Error('Give --actor <userId> for a real run.');");
  });

  it('reports unless it is told to apply', () => {
    expect(source).toContain("argv.includes('--apply')");
    expect(source).toContain('if (!apply)');
  });

  /** One refusal must not end the run; the rest are other technicians' jobs. */
  it('keeps going when one inspection is refused', () => {
    expect(source).toContain('not added:');
  });
});
