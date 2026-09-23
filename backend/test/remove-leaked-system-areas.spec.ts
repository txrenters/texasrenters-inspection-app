import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The cleanup script must know every way work can be recorded against an area.
 *
 * `remove-leaked-system-areas.mjs` deletes inspection areas that nothing was
 * ever recorded against. It decides "nothing" by checking a hard-coded list of
 * the tables that reference an `InspectionArea` — and a list like that is only
 * ever wrong in one direction. Miss a table and the script deletes an area
 * holding real work, silently, with a cheerful count.
 *
 * That is not hypothetical. Reading this by hand, only `InspectionMedia` was
 * checked, and the conclusion reported to the office was that nothing had ever
 * been photographed. One area held an `InspectionPhoto` and two checklist
 * answers.
 *
 * So the schema decides, and this fails the moment a new table points at an
 * inspection area without the script being taught about it.
 */

const root = join(__dirname, '..');

/** Every model with an `inspectionAreaId`, read from the schema itself. */
function modelsReferencingAnArea(): string[] {
  const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');
  const found: string[] = [];
  for (const block of schema.split(/^model /m).slice(1)) {
    const name = block.slice(0, block.indexOf(' '));
    const body = block.slice(0, block.indexOf('\n}'));
    if (/^\s*inspectionAreaId\s/m.test(body)) found.push(name);
  }
  return found.sort();
}

/** The models the script checks, read out of its own source. */
function modelsTheScriptChecks(): string[] {
  const source = readFileSync(join(root, 'scripts', 'remove-leaked-system-areas.mjs'), 'utf8');
  const list = /const DEPENDENTS = \[([\s\S]*?)\];/.exec(source);
  if (!list) throw new Error('DEPENDENTS not found in remove-leaked-system-areas.mjs');
  return [...list[1]!.matchAll(/\['([A-Za-z]+)',/g)]
    // The script uses the Prisma client's camelCase; the schema declares the
    // model. Compared on the model name so the two are genuinely the same list.
    .map((match) => match[1]![0]!.toUpperCase() + match[1]!.slice(1))
    .sort();
}

describe('removing leaked areas', () => {
  it('checks every table that can hold work against an area', () => {
    expect(modelsTheScriptChecks()).toEqual(modelsReferencingAnArea());
  });

  /** A finalized inspection's report is issued and may already be charged. */
  it('refuses to touch a finalized inspection', () => {
    const source = readFileSync(join(root, 'scripts', 'remove-leaked-system-areas.mjs'), 'utf8');

    expect(source).toContain('area.inspection.finalizedAt');
  });

  /** An HVAC or roof visit's subject IS a SYSTEM area; only room walks leak. */
  it('only looks at inspections that walk rooms', () => {
    const source = readFileSync(join(root, 'scripts', 'remove-leaked-system-areas.mjs'), 'utf8');
    const walks = /const ROOM_WALKS = \[([^\]]*)\]/.exec(source)?.[1] ?? '';

    expect(walks).toContain('OCCUPIED');
    expect(walks).not.toContain('HVAC');
    expect(walks).not.toContain('ROOF');
  });

  /**
   * A wrong area is a smaller problem than no area.
   *
   * One move-in in production has exactly one area and it is the leaked one.
   * Removing it leaves a technician opening a visit with nothing to walk, and
   * leaves the move-out that will be compared against it with counterparts
   * that never resolve.
   */
  it('never empties an inspection', () => {
    const source = readFileSync(join(root, 'scripts', 'remove-leaked-system-areas.mjs'), 'utf8');

    expect(source).toContain('wouldEmpty');
    expect(source).toContain('it is the only area this inspection has');
  });

  /** Reporting is the default; deleting takes a deliberate flag. */
  it('reports unless it is told to apply', () => {
    const source = readFileSync(join(root, 'scripts', 'remove-leaked-system-areas.mjs'), 'utf8');

    expect(source).toContain("argv.includes('--apply')");
    expect(source).toContain('if (!apply)');
  });
});
