/**
 * Syncs Jobber visits over a named slice of the calendar.
 *
 * The scheduled sync uses a *rolling* window — seven days back, sixty forward —
 * which is right for keeping up and cannot reach the past. Anything older than
 * a week is invisible to every run no matter how often it runs, which is why
 * the console showed only September's occupied inspections: the July and August
 * visits were never outside a window, they were never inside one.
 *
 * This takes an explicit window instead. Same worker, same rules, same
 * `processVisit` — nothing here decides what a visit becomes.
 *
 *   node scripts/jobber-backfill-window.mjs --from 2026-07-01 --to 2026-09-30
 *
 * Options
 *   --from YYYY-MM-DD   start of the window (inclusive)
 *   --to   YYYY-MM-DD   end of the window (exclusive of the following day)
 *   --quarter 2026-Q3   shorthand for the calendar quarter
 *
 * Reports `truncated` when Jobber still had pages at the 5,000-visit cap. A
 * partial backfill that looks complete is the failure this is most exposed to,
 * so narrow the window and run it twice rather than trusting a capped number.
 *
 * Runs against the built application. Build first (`npm run build`) or run it
 * inside the API container, where `dist` is already there.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require(join(dist, 'app.module.js'));
const { PrismaService } = require(join(dist, 'common', 'prisma.service.js'));
const { JobberSyncWorker } = require(join(dist, 'workers', 'jobber-sync', 'jobber-sync.worker.js'));
const { withSystemTenant } = require(join(dist, 'database', 'tenant-context.js'));

const argv = process.argv.slice(2);
const value = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

/** The three months a calendar quarter actually covers. */
const QUARTERS = { Q1: [0, 2], Q2: [3, 5], Q3: [6, 8], Q4: [9, 11] };

function resolveWindow() {
  const quarter = value('quarter');
  if (quarter) {
    const match = /^(\d{4})-?(Q[1-4])$/i.exec(quarter.trim());
    if (!match) throw new Error('Use --quarter 2026-Q3');
    const year = Number(match[1]);
    const [first, last] = QUARTERS[match[2].toUpperCase()];
    return {
      startAfter: new Date(Date.UTC(year, first, 1)).toISOString(),
      // The first instant of the following month, so the last day is included
      // whole rather than cut off at midnight.
      startBefore: new Date(Date.UTC(year, last + 1, 1)).toISOString(),
    };
  }
  const from = value('from');
  const to = value('to');
  if (!from || !to) throw new Error('Pass --from and --to, or --quarter.');
  const startBefore = new Date(`${to}T00:00:00.000Z`);
  startBefore.setUTCDate(startBefore.getUTCDate() + 1);
  return {
    startAfter: new Date(`${from}T00:00:00.000Z`).toISOString(),
    startBefore: startBefore.toISOString(),
  };
}

async function main() {
  const window = resolveWindow();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const prisma = app.get(PrismaService);
  const worker = app.get(JobberSyncWorker);

  const organizations = await prisma.organization.findMany({ select: { id: true } });
  if (organizations.length !== 1) {
    console.error(`Expected exactly one organization, found ${organizations.length}.`);
    process.exitCode = 1;
    await app.close();
    return;
  }

  console.log(`syncing ${window.startAfter.slice(0, 10)} → ${window.startBefore.slice(0, 10)}…\n`);
  const result = await worker.run(organizations[0].id, window);

  for (const [key, count] of Object.entries(result))
    if (key !== 'correlationId' && key !== 'truncated') console.log(`  ${key.padEnd(20)} ${count}`);

  if (result.truncated)
    console.log(
      '\nTRUNCATED — Jobber still had visits at the page cap. Split the window and run again;\n' +
        'the counts above are a floor, not a total.',
    );
  await app.close();
}

withSystemTenant(main).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
