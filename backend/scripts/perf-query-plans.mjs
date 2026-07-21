import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function summary(rows) {
  const root = rows?.[0]?.['QUERY PLAN']?.[0]?.Plan;
  return root
    ? {
        nodeType: root['Node Type'],
        totalCost: root['Total Cost'],
        estimatedRows: root['Plan Rows'],
        childNodeTypes: (root.Plans ?? []).map((plan) => plan['Node Type']),
      }
    : { unavailable: true };
}

try {
  const organization = await prisma.organization.findFirst({ select: { id: true } });
  if (!organization) {
    console.log(JSON.stringify({ skipped: 'No organization exists.' }, null, 2));
    process.exit(0);
  }

  const properties = await prisma.$queryRaw`
    EXPLAIN (FORMAT JSON)
    SELECT "id", "name"
    FROM "propertyware_buildings"
    WHERE "organizationId" = ${organization.id}::uuid AND "isActive" = true
    ORDER BY "name" ASC
    LIMIT 20
  `;
  const inspections = await prisma.$queryRaw`
    EXPLAIN (FORMAT JSON)
    SELECT "id", "scheduledAt"
    FROM "Inspection"
    WHERE "organizationId" = ${organization.id}::uuid
    ORDER BY "scheduledAt" DESC
    LIMIT 20
  `;
  const syncRuns = await prisma.$queryRaw`
    EXPLAIN (FORMAT JSON)
    SELECT "id", "completedAt"
    FROM "propertyware_sync_runs"
    WHERE "organizationId" = ${organization.id}::uuid
      AND "status" IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
    ORDER BY "completedAt" DESC
    LIMIT 1
  `;

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        plans: {
          activeProperties: summary(properties),
          scheduledInspectionList: summary(inspections),
          latestSuccessfulSync: summary(syncRuns),
        },
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
