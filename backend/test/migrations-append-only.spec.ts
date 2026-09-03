import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A migration that has run somewhere is finished. It is never edited again.
 *
 * Prisma applies a migration once, by name. Editing the file afterwards changes
 * the source and no database — the statement never runs anywhere it has already
 * been recorded, and the schema and the code drift apart silently.
 *
 * That is not hypothetical. `committedAt` was added to `InspectionImportJob` by
 * editing `202609030002`, which production had already applied. The column
 * existed in `schema.prisma`, the generated client selected it, and every poll
 * of an import job answered 500 with "the column
 * InspectionImportJob.committedAt does not exist in the current database" —
 * while the code reading it was perfectly correct. Nothing else caught it:
 * `tsc` typechecks against the schema, and the tests mock Prisma.
 *
 * The manifest is the record. Adding a migration adds a line to it; editing one
 * changes a hash that is already written down, and this fails.
 */

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const MANIFEST = join(MIGRATIONS, 'applied.lock.json');

const digest = (name: string) =>
  createHash('sha256')
    .update(readFileSync(join(MIGRATIONS, name, 'migration.sql')))
    .digest('hex')
    .slice(0, 16);

const migrationNames = () =>
  readdirSync(MIGRATIONS)
    .filter((name) => existsSync(join(MIGRATIONS, name, 'migration.sql')))
    .sort();

describe('migrations are append-only', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, string>;

  it('has not changed a migration that was already written down', () => {
    // The failure this exists for. If this fails, do not update the manifest to
    // match: write a *new* migration that makes the change, because the old one
    // has already run everywhere it is ever going to.
    const changed = migrationNames()
      .filter((name) => manifest[name] !== undefined && manifest[name] !== digest(name))
      .map((name) => name);

    expect(changed).toEqual([]);
  });

  it('records every migration, so a new one cannot be forgotten', () => {
    const missing = migrationNames().filter((name) => manifest[name] === undefined);
    expect(missing).toEqual([]);
  });

  it('has no manifest entry without a migration behind it', () => {
    // A deleted migration is as bad as an edited one: the database still has it
    // applied and nothing in the tree explains what it did.
    const names = new Set(migrationNames());
    expect(Object.keys(manifest).filter((name) => !names.has(name))).toEqual([]);
  });
});
