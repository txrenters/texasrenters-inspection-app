import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { SaveRevenueDayDto, SaveRevenueLogEntryDto, SaveRevenueMonthDto, SaveRevenueWeekDto } from '../src/admin/actual-vs-budget.controller';
import { ActualVsBudgetService } from '../src/admin/actual-vs-budget.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Saving one cell saves that cell and nothing else (found 2026-11-17: Moses's
 * 11/17 row for 17518 Autumn Hills lost its drive time and time budgeted when
 * its budget was typed). The validation pipe hands the service an instance of
 * the DTO with every field it names, `undefined` where the page sent none; each
 * save here goes through that pipe, as a save from the page does.
 */

const ORG = '90000000-0000-4000-8000-000000000001';
const TECH = '90000000-0000-4000-8000-0000000000a1';
const VISIT = '90000000-0000-4000-8000-0000000000b1';
const office = {
  id: '90000000-0000-4000-8000-000000000009',
  organizationId: ORG,
  displayName: 'Office',
  roles: [UserRole.INSPECTION_SUPERVISOR],
  permissions: ['invoices:read', 'invoices:manage'],
  principalType: 'USER',
} as unknown as AuthenticatedUser;

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const asSent = <T>(metatype: new () => T, body: Record<string, unknown>) => pipe.transform(body, { type: 'body', metatype }) as Promise<T>;

function database() {
  const writes: { table: string; data: Record<string, unknown> }[] = [];
  const db: Record<string, unknown> = {
    inspection: { findFirst: jest.fn(async () => ({ id: VISIT, scheduledAt: new Date('2026-11-17T00:00:00.000Z'), assignments: [{ technicianId: TECH }] })) },
    organizationMember: { findFirst: jest.fn(async () => ({ userProfile: { id: TECH, displayName: 'Moses Rodriguez' } })) },
    revenueLogEntry: {
      findUnique: jest.fn(async () => ({ id: 'entry-1', inspectionId: VISIT, day: new Date('2026-11-17T00:00:00.000Z'), driveTime: '10–20 min', timeBudgeted: '30 mins', estimatedBudgetCents: null })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.push({ table: 'log', data });
        return { id: 'entry-1' };
      }),
    },
    revenueDayEntry: {
      findUnique: jest.fn(async () => ({ budgetCents: 40000, workSeconds: 28800, dailyRemarks: 'Kept', projectionRemarks: 'Kept too', trackerRemarks: null })),
      upsert: jest.fn(async ({ update }: { update: Record<string, unknown> }) => writes.push({ table: 'day', data: update })),
    },
    revenueWeekEntry: {
      findUnique: jest.fn(async () => ({ targetCents: 200000, actualCents: 150000, remarks: 'Kept' })),
      upsert: jest.fn(async ({ update }: { update: Record<string, unknown> }) => writes.push({ table: 'week', data: update })),
    },
    revenueMonthEntry: {
      findUnique: jest.fn(async () => ({ remarks: 'Old' })),
      upsert: jest.fn(async ({ update }: { update: Record<string, unknown> }) => writes.push({ table: 'month', data: update })),
    },
    auditLog: { create: jest.fn(async () => undefined) },
    excelSync: { updateMany: jest.fn(async () => ({ count: 0 })) },
  };
  db.$transaction = jest.fn(async (work: (tx: unknown) => unknown) => work(db));
  return { service: new ActualVsBudgetService(db as never), writes };
}

const fieldsOf = (data: Record<string, unknown>) => Object.keys(data).filter((field) => field !== 'updatedById').sort();

describe('saving one cell', () => {
  it("on a visit's log row saves that cell, and leaves the row's drive time and time budgeted as they are", async () => {
    const { service, writes } = database();
    await service.saveVisit(office, VISIT, await asSent(SaveRevenueLogEntryDto, { estimatedBudgetCents: 7899 }));
    expect(writes).toEqual([{ table: 'log', data: expect.objectContaining({ estimatedBudgetCents: 7899 }) }]);
    expect(fieldsOf(writes[0]!.data)).toEqual(['estimatedBudgetCents']);
  });

  it('clears a cell only when the page sends it empty', async () => {
    const { service, writes } = database();
    await service.saveVisit(office, VISIT, await asSent(SaveRevenueLogEntryDto, { driveTime: null }));
    expect(writes[0]!.data).toEqual(expect.objectContaining({ driveTime: null }));
    expect(fieldsOf(writes[0]!.data)).toEqual(['driveTime']);
  });

  it("on an office row's entry saves that cell only", async () => {
    const { service, writes } = database();
    const db = (service as unknown as { prisma: { revenueLogEntry: { findFirst?: unknown } } }).prisma;
    db.revenueLogEntry.findFirst = jest.fn(async () => ({ id: 'entry-1', inspectionId: null, day: new Date('2026-11-17T00:00:00.000Z'), notes: 'Kept' }));
    await service.saveEntry(office, 'entry-1', await asSent(SaveRevenueLogEntryDto, { workOrder: '37826' }));
    expect(fieldsOf(writes[0]!.data)).toEqual(['workOrder']);
  });

  it("on a day's sheet saves that cell only: the day's budget, work time and other remarks stay", async () => {
    const { service, writes } = database();
    await service.saveDay(office, TECH, '2026-11-17', await asSent(SaveRevenueDayDto, { trackerRemarks: 'Short day' }));
    expect(fieldsOf(writes[0]!.data)).toEqual(['trackerRemarks']);
  });

  it("on a week's report saves that cell only: its target and actual stay", async () => {
    const { service, writes } = database();
    await service.saveWeek(office, TECH, '2026-11-16', await asSent(SaveRevenueWeekDto, { remarks: 'Good week' }));
    expect(fieldsOf(writes[0]!.data)).toEqual(['remarks']);
  });

  it("on a month's report saves its remarks", async () => {
    const { service, writes } = database();
    await service.saveMonth(office, TECH, '2026-11', await asSent(SaveRevenueMonthDto, { remarks: 'Strong month' }));
    expect(fieldsOf(writes[0]!.data)).toEqual(['remarks']);
  });
});
