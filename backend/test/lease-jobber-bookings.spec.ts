jest.mock('../src/integrations/jobber/jobber.booking', () => ({ linkedJobberProperty: jest.fn() }));
jest.mock('../src/admin/tenancy-on-file', () => ({ tenancyOnFile: jest.fn() }));

import { InspectionStatus, JobberOutboundKind, LeaseInspectionOutcome } from '@prisma/client';

import { tenancyOnFile } from '../src/admin/tenancy-on-file';
import { linkedJobberProperty } from '../src/integrations/jobber/jobber.booking';
import { queueLeaseBookingsInJobber } from '../src/planning/lease-jobber-bookings';

/**
 * Lease move-outs and move-ins booked in Jobber too (the office, 2026-10-01:
 * every visit on both calendars, syncing both ways). People and places invented.
 */

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

const scheduled = (over: Record<string, unknown> = {}, detail: string | null = null) => ({
  id: 'row-1',
  detail,
  inspection: {
    id: 'inspection-1',
    inspectionType: 'MOVE_OUT',
    scheduledAt: date('2026-10-21'),
    internalNotes: 'Booked from Propertyware: the tenancy ends Tue, Oct 20, 2026, and its move-out is the day after.',
    propertywareBuildingId: 'building-1',
    propertywareUnitId: null,
    propertywareLeaseId: 'lease-1',
    propertywareBuilding: { name: 'Main', addressLine1: '1 Main St' },
    propertywareUnit: null,
    ...over,
  },
});

function build(rows: unknown[], connected = true, inJobberNotHere: unknown[] = []) {
  const tx = {
    inspection: { update: jest.fn().mockResolvedValue({}) },
    jobberOutboundTask: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    leaseScheduledInspection: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    jobberConnection: { findUnique: jest.fn().mockResolvedValue({ status: connected ? 'CONNECTED' : 'DISCONNECTED' }) },
    leaseScheduledInspection: { findMany: jest.fn().mockResolvedValue(rows), update: jest.fn().mockResolvedValue({}) },
    jobberVisitImport: { findMany: jest.fn().mockResolvedValue(inJobberNotHere.map((payload) => ({ payload }))) },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  return { prisma, tx };
}

describe('lease visits booked in Jobber too', () => {
  const previous = { ...process.env };
  beforeEach(() => {
    process.env.JOBBER_BOOKING_ENABLED = 'true';
    process.env.WEB_APP_ORIGIN = 'https://console.example.com';
    jest.mocked(linkedJobberProperty).mockReset().mockResolvedValue({ status: 'LINKED', jobberPropertyId: 'jp-1', address: '1 Main St' } as never);
    jest.mocked(tenancyOnFile).mockReset().mockResolvedValue({
      tenancy: { zone: '1', managementPlan: null, hvacPlan: null, hvacFilterLocation: null, hvacFilterSizes: [], tbpEnrollment: null },
      lease: null,
      tenantNames: ['Pat Doe'],
    } as never);
  });
  afterEach(() => {
    process.env = { ...previous };
  });

  it('asks only for scheduled, unstarted ones from today on that Jobber has not been asked for', async () => {
    const { prisma } = build([]);

    await queueLeaseBookingsInJobber(prisma as never, 'org-1', '2026-10-01');

    expect(prisma.leaseScheduledInspection.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      outcome: LeaseInspectionOutcome.SCHEDULED,
      inspection: {
        status: InspectionStatus.SCHEDULED,
        startedAt: null,
        jobberVisitId: null,
        scheduledAt: { gte: date('2026-10-01') },
        jobberOutboundTasks: { none: { kind: JobberOutboundKind.VISIT_CREATE } },
      },
    });
  });

  it('queues a move-out as the office titles one, with the tenant who is leaving', async () => {
    const { prisma, tx } = build([scheduled()]);

    await expect(queueLeaseBookingsInJobber(prisma as never, 'org-1', '2026-10-01')).resolves.toEqual({ queued: 1, notLinked: 0, alreadyInJobber: 0 });

    const written = tx.inspection.update.mock.calls[0][0];
    expect(written.where).toEqual({ id: 'inspection-1' });
    expect(written.data.jobberVisitTitle).toBe('1 Main St - Zone 1 - Move out inspection');
    expect(written.data.jobberVisitDetails).toContain('Tenant: Pat Doe');
    expect(written.data.jobberVisitDetails).toContain('https://console.example.com/inspections/inspection-1');
    expect(tx.jobberOutboundTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inspectionId: 'inspection-1',
        kind: JobberOutboundKind.VISIT_CREATE,
        jobTitle: 'Zone 1 - Move out inspection',
        createdById: null,
      }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'JOBBER_VISIT_BOOKING_QUEUED',
        metadata: { jobberPropertyId: 'jp-1', inspectionType: 'MOVE_OUT', fromLease: true },
      }),
    });
  });

  it('never names the tenant who left on a move-in', async () => {
    const { prisma, tx } = build([scheduled({ inspectionType: 'MOVE_IN' })]);

    await queueLeaseBookingsInJobber(prisma as never, 'org-1', '2026-10-01');

    const written = tx.inspection.update.mock.calls[0][0].data;
    expect(written.jobberVisitTitle).toBe('1 Main St - Zone 1 - Move in Inspection');
    expect(written.jobberVisitDetails).not.toContain('Pat Doe');
  });

  it('leaves one at a property Jobber does not know, and says so on its row', async () => {
    jest.mocked(linkedJobberProperty).mockResolvedValue({ status: 'NOT_LINKED' } as never);
    const { prisma, tx } = build([scheduled()]);

    await expect(queueLeaseBookingsInJobber(prisma as never, 'org-1', '2026-10-01')).resolves.toEqual({ queued: 0, notLinked: 1, alreadyInJobber: 0 });

    expect(tx.jobberOutboundTask.create).not.toHaveBeenCalled();
    expect(prisma.leaseScheduledInspection.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { detail: expect.stringContaining('not linked to a Jobber property') },
    });
  });

  it('books nothing when Jobber already has the office’s own move-out near the day, not imported here', async () => {
    const office = { title: '1 Main St - Zone 1 - Move out inspection', startAt: '2026-10-22T05:00:00Z', property: { id: 'jp-1' } };
    const { prisma, tx } = build([scheduled()], true, [office]);

    await expect(queueLeaseBookingsInJobber(prisma as never, 'org-1', '2026-10-01')).resolves.toEqual({
      queued: 0,
      notLinked: 0,
      alreadyInJobber: 1,
    });

    expect(tx.jobberOutboundTask.create).not.toHaveBeenCalled();
    expect(prisma.jobberVisitImport.findMany.mock.calls[0][0].where).toMatchObject({
      payload: { path: ['property', 'id'], equals: 'jp-1' },
    });
    expect(prisma.leaseScheduledInspection.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { detail: expect.stringContaining('Jobber already has this move-out for 2026-10-22') },
    });
  });

  it('still books when the office’s visit there is other work, or far from the day', async () => {
    const cleaning = { title: '1 Main St - Home Cleaning', startAt: '2026-10-21T05:00:00Z', property: { id: 'jp-1' } };
    const longAgo = { title: '1 Main St - Move out inspection', startAt: '2026-06-01T05:00:00Z', property: { id: 'jp-1' } };
    const { prisma, tx } = build([scheduled()], true, [cleaning, longAgo]);

    await queueLeaseBookingsInJobber(prisma as never, 'org-1', '2026-10-01');

    expect(tx.jobberOutboundTask.create).toHaveBeenCalledTimes(1);
  });

  it('does nothing while bookings are off, or Jobber is not connected', async () => {
    const connectedOff = build([scheduled()], false);
    await expect(queueLeaseBookingsInJobber(connectedOff.prisma as never, 'org-1', '2026-10-01')).resolves.toBeNull();

    process.env.JOBBER_BOOKING_ENABLED = 'false';
    const off = build([scheduled()]);
    await expect(queueLeaseBookingsInJobber(off.prisma as never, 'org-1', '2026-10-01')).resolves.toBeNull();
    expect(off.prisma.leaseScheduledInspection.findMany).not.toHaveBeenCalled();
  });
});
