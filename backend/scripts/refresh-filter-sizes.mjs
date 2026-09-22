/**
 * Re-reads a quarter's filter sizes from the tenant report, from the server.
 *
 * The same `TbpPlanService.refreshFilterSizes` the console's **Filter sizes**
 * button calls — this is a way in, not a second implementation. Every rule
 * about what it will and will not touch lives in that method and is tested
 * there; nothing here decides anything.
 *
 *   node scripts/refresh-filter-sizes.mjs --quarter 2026-Q4 --dry-run
 *   node scripts/refresh-filter-sizes.mjs --quarter 2026-Q4 --actor <userId>
 *
 * Options
 *   --quarter 2026-Q4   the quarter to refresh
 *   --plan <id>         that quarter's plan, when you already have the id
 *   --actor <userId>    who the audit names. Required for a real run: the audit
 *                       row for four hundred appointments has to name somebody
 *                       who exists, and guessing would put a coordinator's name
 *                       on something they did not do.
 *   --dry-run           report what the quarter looks like and change nothing
 *
 * `--dry-run` does not call the service at all. It counts, from the same rule
 * the service uses, how many stops would take new sizes and how many tenancies
 * the report still holds no size for — so the numbers can be checked against
 * the office's own before anything writes.
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
const { TbpPlanService } = require(join(dist, 'planning', 'tbp-plan.service.js'));
const { withSystemTenant } = require(join(dist, 'database', 'tenant-context.js'));
const { FILTER_SIZE_IN_TEXT } = require('@texasrenters/shared');

const argv = process.argv.slice(2);
const value = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const flag = (name) => argv.includes(`--${name}`);

function quarterOf(text) {
  const match = /^(\d{4})-?(Q[1-4])$/i.exec((text ?? '').trim());
  if (!match) throw new Error('Use --quarter 2026-Q4');
  return { year: Number(match[1]), quarter: Number(match[2].slice(1)) };
}

async function main() {
  const dryRun = flag('dry-run');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const prisma = app.get(PrismaService);
  const plans = app.get(TbpPlanService);

  await withSystemTenant(async () => {
    const organizations = await prisma.organization.findMany({ select: { id: true } });
    if (organizations.length !== 1)
      throw new Error(`Expected exactly one organization, found ${organizations.length}.`);
    const organizationId = organizations[0].id;

    let planId = value('plan');
    let label = planId;
    if (!planId) {
      const { year, quarter } = quarterOf(value('quarter'));
      const plan = await prisma.tbpQuarterPlan.findFirst({
        where: { organizationId, quarterYear: year, quarterNumber: quarter },
        select: { id: true, status: true, stopCount: true },
      });
      if (!plan) throw new Error(`No plan for Q${quarter} ${year}.`);
      planId = plan.id;
      label = `Q${quarter} ${year} (${plan.status}, ${plan.stopCount} stops)`;
    }

    if (dryRun) {
      // Counted here rather than by calling the service, because the service
      // writes. The rule is the shared one, so the numbers are the service's.
      const stops = await prisma.tbpQuarterPlanStop.findMany({
        where: { planId, organizationId, status: { not: 'EXCLUDED' } },
        select: {
          hvacFilterSizes: true,
          visitDetailsOverriddenAt: true,
          tenant: { select: { addressLine1: true, hvacFilterSizes: true } },
          inspection: { select: { status: true } },
        },
      });
      const printable = (sizes) => sizes.filter((size) => FILTER_SIZE_IN_TEXT.test(size));
      let differ = 0;
      let finished = 0;
      const missing = [];
      for (const stop of stops) {
        if (stop.inspection && (stop.inspection.status === 'COMPLETED' || stop.inspection.status === 'CANCELLED')) {
          finished += 1;
          continue;
        }
        const live = stop.tenant.hvacFilterSizes;
        if (!printable(live).length) missing.push(stop.tenant.addressLine1 ?? '(no address)');
        const same =
          live.length === stop.hvacFilterSizes.length &&
          live.every((size, index) => size === stop.hvacFilterSizes[index]);
        if (!same) differ += 1;
      }
      console.log(`DRY RUN — ${label}\n`);
      console.log(`  stops                        ${stops.length}`);
      console.log(`  would take new sizes         ${differ}`);
      console.log(`  already walked or called off ${finished}   (left alone)`);
      console.log(`  no size in Propertyware      ${missing.length}`);
      if (missing.length) {
        console.log('\n  the office fills these in at the source:');
        for (const address of [...new Set(missing)].sort()) console.log(`    ${address}`);
      }
      console.log('\nNothing was changed. Drop --dry-run and pass --actor <userId> to run it.');
      return;
    }

    const actorId = value('actor');
    const actorEmail = value('actor-email');
    if (!actorId && !actorEmail) {
      // Rather than a bare refusal: the audit row for a quarter of real
      // appointments has to name somebody who exists, so show who it could be.
      const candidates = await prisma.user.findMany({
        where: { organizationId, isActive: true },
        select: { id: true, displayName: true, authUser: { select: { email: true } } },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      console.log('Pass --actor <userId> or --actor-email <email>. Active users:');
      for (const user of candidates)
        console.log(`  ${user.id}  ${user.displayName} <${user.authUser?.email ?? 'no email'}>`);
      return;
    }
    const actor = await prisma.user.findFirst({
      where: {
        organizationId,
        ...(actorId ? { id: actorId } : { authUser: { email: { equals: actorEmail, mode: 'insensitive' } } }),
      },
      select: { id: true, displayName: true },
    });
    if (!actor) throw new Error(`No user ${actorId ?? actorEmail} in this organization.`);

    console.log(`refreshing ${label}, audited to ${actor.displayName}…\n`);
    const result = await plans.refreshFilterSizes(
      { id: actor.id, organizationId, principalType: 'USER' },
      planId,
    );

    const line = (name, count) => console.log(`  ${name.padEnd(30)} ${count}`);
    line('stops', result.stops);
    line('took new sizes', result.updated);
    line('Details rewritten', result.detailsRewritten);
    line('queued for Jobber', result.jobberQueued);
    line('changed here only (Jobber off)', result.notSentToJobber);
    line('kept: coordinator’s Details', result.keptOverridden);
    line('kept: already walked/called off', result.keptFinished);
    line('kept: edited in the console', result.keptEditedInConsole);
    line('kept: unit no longer active', result.keptUnresolvedUnit);
    line('failed', result.failed);
    line('still no size in Propertyware', result.stillMissing.length);

    if (result.jobberPushDisabled)
      console.log(
        '\nJOBBER EDITS ARE OFF on this server. The visits changed here; Jobber still\n' +
          'shows the old text, so the technician does too.',
      );
    if (result.stillMissing.length) {
      console.log('\nNo size in Propertyware — the office fills these in at the source:');
      for (const address of [...new Set(result.stillMissing.map((t) => t.address))].sort())
        console.log(`  ${address}`);
    }
  });

  await app.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
