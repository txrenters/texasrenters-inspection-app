import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The booking index is raw SQL, because Prisma can express neither a partial
 * index nor NULLS NOT DISTINCT. Nothing in the type system protects it, so its
 * two load-bearing properties are asserted against the migration file itself.
 *
 * Both have a specific failure attached. Widening the predicate to every
 * non-terminal status breaks reopening — COMPLETED is reopenable, and terminal
 * work deliberately does not clash, so a completed visit and a newly booked one
 * can share a day until somebody reopens the completed one. Dropping NULLS NOT
 * DISTINCT silently exempts every "entire property" booking, which has no unit,
 * from the only constraint meant to cover it.
 */
const RAW = readFileSync(
  join(
    __dirname,
    '..',
    'prisma',
    'migrations',
    '202608310006_inspection_booking_unique',
    'migration.sql',
  ),
  'utf8',
);

/**
 * The executable statement, with `--` comments stripped.
 *
 * The comments deliberately quote the predicate this index rejects
 * (`status NOT IN (...)`) to explain why, so asserting against the raw file
 * matches the explanation rather than the index.
 */
const MIGRATION = RAW.split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('inspection booking index', () => {
  it('is scoped to SCHEDULED, so reopening a completed inspection cannot collide', () => {
    expect(MIGRATION).toMatch(/WHERE\s+status\s*=\s*'SCHEDULED'/i);
    expect(MIGRATION).not.toMatch(/status\s+NOT\s+IN/i);
  });

  it('treats NULLs as equal, or an entire-property booking escapes it', () => {
    expect(MIGRATION).toMatch(/NULLS\s+NOT\s+DISTINCT/i);
  });

  it('keys on the same columns the application rule compares', () => {
    for (const column of [
      'organizationId',
      'propertywareBuildingId',
      'propertywareUnitId',
      'inspectionType',
      'scheduledAt',
    ])
      expect(MIGRATION).toContain(`"${column}"`);
  });

  it('is named, because the 409 mapping matches on that name', () => {
    // admin.service maps P2002 to DUPLICATE_INSPECTION only for this index;
    // renaming it here without renaming it there turns a 409 back into a 500.
    expect(MIGRATION).toContain('Inspection_scheduled_booking_key');
  });
});
