import { createRequire } from 'node:module';

import { measure } from './perf-utils.mjs';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

if (process.argv.includes('--session') && process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. No connection value was printed.');
  process.exit(1);
}

const databaseUrl = new URL(process.env.DATABASE_URL);
const prisma = new PrismaClient();
const report = {
  generatedAt: new Date().toISOString(),
  connection: {
    category: 'direct',
    host: databaseUrl.hostname,
    port: databaseUrl.port || '5432',
  },
  measurements: {},
};

try {
  report.measurements.selectOne = (await measure(() => prisma.$queryRawUnsafe('SELECT 1'))).summary;

  const lookupSeed = await prisma.userProfile.findFirst({ select: { id: true } });
  report.measurements.indexedUserLookup = lookupSeed
    ? (
        await measure(() =>
          prisma.userProfile.findUnique({ where: { id: lookupSeed.id }, select: { id: true } }),
        )
      ).summary
    : { skipped: 'No user profile exists.' };

  const organization = await prisma.organization.findFirst({ select: { id: true } });
  report.measurements.propertyList = organization
    ? (
        await measure(() =>
          prisma.propertywareBuilding.findMany({
            where: { organizationId: organization.id, isActive: true },
            orderBy: { name: 'asc' },
            take: 20,
            select: {
              id: true,
              name: true,
              addressLine1: true,
              city: true,
              state: true,
              postalCode: true,
            },
          }),
        )
      ).summary
    : { skipped: 'No organization exists.' };

  console.log(JSON.stringify(report, null, 2));
} finally {
  await prisma.$disconnect();
}
