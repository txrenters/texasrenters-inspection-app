import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ids = {
  organization: '10000000-0000-4000-8000-000000000001',
  systemAdmin: '10000000-0000-4000-8000-000000000002',
  propertyAdmin: '10000000-0000-4000-8000-000000000003',
  technician: '10000000-0000-4000-8000-000000000004',
  reviewer: '10000000-0000-4000-8000-000000000005',
  chargeApprover: '10000000-0000-4000-8000-000000000006',
  property: '20000000-0000-4000-8000-000000000001',
  floorPlan: '20000000-0000-4000-8000-000000000002',
  groundFloor: '20000000-0000-4000-8000-000000000003',
  secondFloor: '20000000-0000-4000-8000-000000000004',
  inspection: '30000000-0000-4000-8000-000000000001',
  baseline: '30000000-0000-4000-8000-000000000002',
};

const users = [
  [ids.systemAdmin, 'system-admin', 'system.admin@local.test', 'System Admin', 'SYSTEM_ADMIN'],
  [
    ids.propertyAdmin,
    'property-admin',
    'property.admin@local.test',
    'Property Admin',
    'PROPERTY_ADMIN',
  ],
  [
    ids.technician,
    'technician',
    'technician@local.test',
    'Taylor Technician',
    'INSPECTION_TECHNICIAN',
  ],
  [ids.reviewer, 'reviewer', 'reviewer@local.test', 'Riley Reviewer', 'CONDITION_REVIEWER'],
  [
    ids.chargeApprover,
    'charge-approver',
    'charge.approver@local.test',
    'Casey Approver',
    'CHARGE_APPROVER',
  ],
] as const;

const areaSeeds = [
  ['Entryway', ids.groundFloor, true],
  ['Living Area', ids.groundFloor, true],
  ['Kitchen', ids.groundFloor, true],
  ['Dining Area', ids.groundFloor, true],
  ['Common Bathroom', ids.groundFloor, true],
  ['Garage', ids.groundFloor, false],
  ['Master Bedroom', ids.secondFloor, true],
  ['Master Bathroom', ids.secondFloor, true],
  ['Bedroom 1', ids.secondFloor, true],
  ['Bedroom 2', ids.secondFloor, true],
  ['Common Bathroom 2', ids.secondFloor, true],
] as const;

async function main() {
  await prisma.organization.upsert({
    where: { id: ids.organization },
    update: {},
    create: { id: ids.organization, name: 'TexasRenters Development' },
  });

  for (const [id, authUserId, email, displayName, role] of users) {
    await prisma.userProfile.upsert({
      where: { id },
      update: {},
      create: { id, authUserId, email, displayName },
    });
    await prisma.organizationMember.upsert({
      where: {
        organizationId_userProfileId_role: {
          organizationId: ids.organization,
          userProfileId: id,
          role,
        },
      },
      update: {},
      create: { organizationId: ids.organization, userProfileId: id, role },
    });
  }

  await prisma.property.upsert({
    where: { id: ids.property },
    update: {},
    create: {
      id: ids.property,
      organizationId: ids.organization,
      name: 'Oak Ridge House',
      addressLine1: '1458 Oak Ridge Drive',
      city: 'Austin',
      postalCode: '78704',
    },
  });
  await prisma.propertyFloorPlan.upsert({
    where: { id: ids.floorPlan },
    update: {},
    create: {
      id: ids.floorPlan,
      propertyId: ids.property,
      fileName: 'oak-ridge-floor-plan.pdf',
      mimeType: 'application/pdf',
      storageKey: 'development/oak-ridge-floor-plan.pdf',
      sizeBytes: 245760,
      status: 'APPROVED',
    },
  });
  await prisma.propertyFloor.upsert({
    where: { id: ids.groundFloor },
    update: {},
    create: { id: ids.groundFloor, propertyId: ids.property, name: 'Ground Floor', sortOrder: 1 },
  });
  await prisma.propertyFloor.upsert({
    where: { id: ids.secondFloor },
    update: {},
    create: { id: ids.secondFloor, propertyId: ids.property, name: 'Second Floor', sortOrder: 2 },
  });

  const areas: { id: string; name: string; isRequired: boolean }[] = [];
  for (const [index, [name, floorId, isRequired]] of areaSeeds.entries()) {
    const id = `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const area = await prisma.propertyArea.upsert({
      where: { id },
      update: {},
      create: {
        id,
        propertyId: ids.property,
        floorId,
        name,
        inspectionOrder: index + 1,
        isRequired,
        status: 'APPROVED',
        source: 'MOCK_AI_REVIEWED',
      },
    });
    areas.push(area);
  }

  await prisma.baselineInspection.upsert({
    where: { id: ids.baseline },
    update: {},
    create: {
      id: ids.baseline,
      propertyId: ids.property,
      inspectedAt: new Date('2025-08-01T14:00:00Z'),
    },
  });
  const bedroom = areas.find((area) => area.name === 'Bedroom 1');
  if (!bedroom) throw new Error('Bedroom 1 seed area missing');
  await prisma.baselineAreaCondition.upsert({
    where: {
      baselineInspectionId_propertyAreaId: {
        baselineInspectionId: ids.baseline,
        propertyAreaId: bedroom.id,
      },
    },
    update: {},
    create: {
      baselineInspectionId: ids.baseline,
      propertyAreaId: bedroom.id,
      conditionSummary: 'Walls, carpet, closet door, window, and ceiling were in good condition.',
      knownDefects: ['Small paint chip beside the light switch'],
    },
  });

  await prisma.inspection.upsert({
    where: { id: ids.inspection },
    update: {},
    create: {
      id: ids.inspection,
      organizationId: ids.organization,
      propertyId: ids.property,
      inspectionType: 'MOVE_IN',
      scheduledAt: new Date('2026-07-18T15:00:00Z'),
    },
  });
  const existingAssignment = await prisma.inspectionAssignment.findFirst({
    where: { inspectionId: ids.inspection, isCurrent: true },
  });
  if (!existingAssignment)
    await prisma.inspectionAssignment.create({
      data: {
        inspectionId: ids.inspection,
        technicianId: ids.technician,
        assignedById: ids.propertyAdmin,
      },
    });
  for (const [index, area] of areas.entries()) {
    const id = `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    await prisma.inspectionArea.upsert({
      where: { id },
      update: {},
      create: { id, inspectionId: ids.inspection, propertyAreaId: area.id },
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Seed failed');
    await prisma.$disconnect();
    process.exit(1);
  });
