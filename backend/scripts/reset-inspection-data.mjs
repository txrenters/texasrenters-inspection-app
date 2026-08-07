#!/usr/bin/env node
/**
 * Delete every inspection and its evidence, keeping accounts and the
 * Propertyware catalogue.
 *
 * For clearing a development environment back to a state where a new inspection
 * can be created immediately — no re-sync, no re-inviting technicians.
 *
 * KEPT: organizations, roles and permissions, user profiles and technician
 * accounts, memberships, AI provider settings, charge rules, properties, and
 * everything synced from Propertyware.
 *
 * DELETED: inspections, assignments, areas, recordings, photos, findings,
 * reviews, transcripts, AI jobs, charges, pet records, baselines, the property
 * floor/area structure, and the audit log.
 *
 * Dry run by default. Nothing is deleted without `--confirm`, because the
 * destination is whatever DATABASE_URL points at and that is frequently a
 * hosted database rather than a local one.
 *
 *   node scripts/reset-inspection-data.mjs
 *   node scripts/reset-inspection-data.mjs --confirm
 */

import { ownerPrismaClient } from './owner-prisma.mjs';

/**
 * Children before parents.
 *
 * A wrong order surfaces as a foreign-key error inside the transaction, which
 * rolls the whole thing back — the safe failure. Two of these are here only
 * because they hang off PropertyArea and cannot outlive it: `areaChecklistItem`
 * and `propertyAreaAlias`.
 */
const ORDER = [
  'findingReview',
  'charge',
  'petObservation',
  'petCandidate',
  'transcriptSegment',
  'transcriptionJob',
  'aiAnalysisJob',
  'mediaProcessingEvent',
  'inspectionPhoto',
  'inspectionFinding',
  'mediaUploadSession',
  'inspectionMedia',
  'inspectionReportShare',
  'inspectionAreaComparison',
  'inspectionComparison',
  'inspectionAreaStatusHistory',
  'inspectionAssignment',
  'inspectionArea',
  'baselineMedia',
  'baselineAreaCondition',
  'baselineInspection',
  'inspection',
  'areaChecklistItem',
  'propertyAreaAlias',
  'propertyArea',
  'propertyFloor',
  'auditLog',
];

const confirmed = process.argv.includes('--confirm');
// Owner connection: this script is deliberately cross-organization, and the
// application role is subject to the tenant-isolation policies.
const prisma = ownerPrismaClient();

try {
  // Named so nobody discovers afterwards that they cleared the wrong database.
  const [{ host, db }] = await prisma.$queryRawUnsafe(
    `select inet_server_addr()::text as host, current_database() as db`,
  ).catch(() => [{ host: 'unknown', db: 'unknown' }]);
  console.log(`\n  Database : ${db} @ ${host}`);

  const unknown = ORDER.filter((model) => typeof prisma[model]?.deleteMany !== 'function');
  if (unknown.length) {
    console.error(`\n  Unknown models: ${unknown.join(', ')}\n  Schema has changed; update ORDER.\n`);
    process.exit(1);
  }

  const counts = {};
  for (const model of ORDER) counts[model] = await prisma[model].count();
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  console.log('\n  Rows that will be deleted:\n');
  for (const [model, count] of Object.entries(counts)) if (count) console.log(`    ${model.padEnd(28)} ${count}`);
  console.log(`\n    ${'total'.padEnd(28)} ${total}`);

  const kept = {
    userProfile: await prisma.userProfile.count(),
    organizationMember: await prisma.organizationMember.count(),
    property: await prisma.property.count(),
    propertywareBuilding: await prisma.propertywareBuilding.count(),
  };
  console.log('\n  Kept:\n');
  for (const [model, count] of Object.entries(kept)) console.log(`    ${model.padEnd(28)} ${count}`);

  if (!confirmed) {
    console.log('\n  Dry run. Re-run with --confirm to delete.\n');
    process.exit(0);
  }

  const deleted = {};
  await prisma.$transaction(
    async (tx) => {
      // An inspection can name another as its comparison baseline, so the
      // self-reference is cleared before the rows go.
      await tx.inspection.updateMany({ data: { baselineInspectionId: null } });
      for (const model of ORDER) {
        const result = await tx[model].deleteMany({});
        if (result.count) deleted[model] = result.count;
      }
    },
    // Well beyond the client default: this is many statements against a remote
    // pooler, and a partial delete would be worse than a slow one.
    { timeout: 120_000, maxWait: 20_000 },
  );

  console.log('\n  Deleted:\n');
  for (const [model, count] of Object.entries(deleted)) console.log(`    ${model.padEnd(28)} ${count}`);
  console.log('\n  Done. Accounts and the Propertyware catalogue are untouched.\n');
} finally {
  await prisma.$disconnect();
}
