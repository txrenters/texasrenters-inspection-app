/**
 * Brings Propertyware's inspection reports into the console.
 *
 * The office had been exporting these one at a time. A live survey found 4,664
 * of them — 683 move-ins, 473 move-outs, 1,745 occupied — across 454 of 577
 * buildings, weighted to the present rather than the archive: 1,442 from 2025
 * and 1,188 from 2026. Every one is an Inspect & Cloud report in the layout the
 * importer was built and proven against.
 *
 * Two passes, run separately, because they cost wildly different amounts.
 *
 *   node scripts/propertyware-inspection-docs.mjs --discover
 *       One listing request per building. Writes catalogue rows and downloads
 *       nothing. Safe to re-run; safe to interrupt.
 *
 *   node scripts/propertyware-inspection-docs.mjs --import
 *       Downloads and imports what discovery catalogued. A dry run unless
 *       `--apply` is passed, and worth rehearsing with `--limit` first: each
 *       document is a multi-megabyte download and one is 81 MB.
 *
 * Options
 *   --apply                  actually write (import is a dry run without it)
 *   --types MOVE_IN,MOVE_OUT restrict to these inspection types
 *   --since 2023-01-01       ignore anything older
 *   --limit 25               stop after this many
 *   --actor someone@example  who the evidence is attributed to; required to import
 *
 * Runs against the built application, so the rules live in one place: the same
 * guards, the same parser and the same writer the console uses. Build first
 * (`npm run build`) or run it inside the API container, where `dist` is already
 * there.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require(join(dist, 'app.module.js'));
const { PrismaService } = require(join(dist, 'common', 'prisma.service.js'));
const {
  PropertywareInspectionDocsService,
} = require(join(dist, 'integrations', 'propertyware', 'propertyware.inspection-docs.service.js'));
const { withSystemTenant } = require(join(dist, 'database', 'tenant-context.js'));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const DISCOVER = flag('discover');
const IMPORT = flag('import');
const APPLY = flag('apply');

if (!DISCOVER && !IMPORT) {
  console.error('Pass --discover or --import (see the header of this file).');
  process.exit(1);
}

/**
 * Everything runs inside the system tenant.
 *
 * Every table this touches carries a tenant-isolation policy keyed on
 * `app.organization_id`, and a script has no request to take one from. With it
 * unset the policy matches nothing and the run reports "0 organizations" --
 * indistinguishable from an empty database, which is exactly the shape of
 * failure the policies are known for. `SYSTEM_TENANT` is the '*' escape the
 * policies already carry for maintenance work.
 */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const prisma = app.get(PrismaService);
  const docs = app.get(PropertywareInspectionDocsService);

  /**
   * One organization, resolved rather than assumed.
   *
   * Every row this writes is organization-scoped and the table carries a
   * tenant-isolation policy, so guessing here would write rows nothing can
   * read back.
   */
  const organizations = await prisma.organization.findMany({ select: { id: true, name: true } });
  if (organizations.length !== 1) {
    console.error(
      `Expected exactly one organization, found ${organizations.length}. Name one explicitly before running this.`,
    );
    process.exitCode = 1;
    await app.close();
    return;
  }
  const organizationId = organizations[0].id;

  if (DISCOVER) {
    const since = value('since') ? new Date(value('since')) : undefined;
    const limit = value('limit') ? Number(value('limit')) : undefined;
    console.log(`discovering documents${since ? ` modified since ${since.toISOString()}` : ''}…`);
    const result = await docs.discover({ organizationId, since, limit });
    console.log(
      `\n${result.buildings} buildings · ${result.listed} documents listed · ` +
        `${result.discovered} new · ${result.alreadyKnown} already catalogued`,
    );
  }

  if (IMPORT) {
    const actorEmail = value('actor');
    if (!actorEmail) {
      console.error('--actor <email> is required: the importer stamps who created each area.');
      process.exitCode = 1;
      await app.close();
      return;
    }
    /**
     * Through `memberships`, because a profile has no organization column.
     *
     * `UserProfile` is one row per person for the whole system -- email is
     * unique across it -- and `OrganizationMember` is what places them in an
     * organization. Filtering on a non-existent `organizationId` field is a
     * Prisma validation error, not an empty result, so this failed loudly
     * rather than quietly importing under the wrong actor.
     */
    const profile = await prisma.userProfile.findFirst({
      where: { email: actorEmail, memberships: { some: { organizationId } } },
      select: { id: true, email: true },
    });
    if (!profile) {
      console.error(`No account in this organization for ${actorEmail}.`);
      process.exitCode = 1;
      await app.close();
      return;
    }
    // The shape the importer expects; the organization is the one resolved
    // above rather than anything read off the profile.
    const actor = { id: profile.id, organizationId, email: profile.email };

    const types = value('types')?.split(',').map((t) => t.trim().toUpperCase());
    const since = value('since') ? new Date(value('since')) : undefined;
    const limit = value('limit') ? Number(value('limit')) : undefined;

    const waiting = await prisma.propertywareInspectionDocument.count({
      where: { organizationId, status: 'DISCOVERED' },
    });
    console.log(`${waiting} catalogued documents waiting; ${APPLY ? 'importing' : 'DRY RUN'}…\n`);

    const result = await docs.importPending({
      organizationId,
      actor,
      types,
      since,
      limit,
      dryRun: !APPLY,
    });
    console.log(
      `\nconsidered ${result.considered} · imported ${result.imported} · ` +
        `skipped ${result.skipped} · failed ${result.failed}`,
    );
    if (!APPLY) console.log('dry run — pass --apply to write');
  }

  await app.close();
}

withSystemTenant(main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
