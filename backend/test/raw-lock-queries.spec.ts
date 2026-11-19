import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { businessDate, dayWords } from '../src/common/business-day';

/**
 * A lock taken with `$queryRaw` must not ask Prisma to read back `void`.
 *
 * `pg_advisory_xact_lock` returns `void`, and `$queryRaw` reads every column it
 * is given: Prisma refuses a `void` column, so the query throws after the lock
 * was taken and the whole request answers 500. That is how every opening
 * balance failed on the day the inventory went live (2026-11-19, v2.5.254):
 * the tests stand Prisma in, and the in-memory database checks ran the SQL, not
 * Prisma reading it back. So this reads the source.
 *
 * Either cast the answer (`::text AS locked`, as every other lock here does) or
 * use `$executeRaw`, which reads nothing back.
 */

const SRC = join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('raw lock queries', () => {
  it('never read back a lock\'s void answer through $queryRaw', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/\$queryRaw(Unsafe)?\s*[`(]/.test(line) && /pg_(try_)?advisory_(xact_)?lock\(/.test(line) && !/::text\b|AS\s+\w+/i.test(line)) offenders.push(`${relative(SRC, file)}:${index + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('finds the mistake it exists for', () => {
    const line = 'await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;';
    expect(/\$queryRaw(Unsafe)?\s*[`(]/.test(line) && /pg_(try_)?advisory_(xact_)?lock\(/.test(line) && !/::text\b|AS\s+\w+/i.test(line)).toBe(true);
  });
});

describe('a refusal that names the Texas day', () => {
  it('says the day as people say it', () => {
    expect(dayWords('2026-11-19')).toBe('November 19');
    expect(dayWords('2027-01-01')).toBe('January 1');
  });

  it('is Texas\'s day, not Manila\'s: just after midnight in Manila it is still the day before in Texas', () => {
    // 2026-11-20 00:55 in Manila is 2026-11-19 16:55 UTC, 10:55 in Texas.
    expect(businessDate(new Date('2026-11-19T16:55:00.000Z'))).toBe('2026-11-19');
  });
});
