import { InspectionSource, InspectionStatus, InspectionType } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import type { ApplicationError } from '../src/common/errors';
import {
  inspectionTypeFor,
  notesFor,
  priorityFor,
  scheduledDayFor,
  WorkOrderIntakeService,
} from '../src/work-orders/work-order-intake.service';
import {
  workOrderHandoffSchema,
  type WorkOrderHandoff,
} from '../src/work-orders/work-order-handoff.schema';

/**
 * Work orders handed over by the maintenance app through the gateway. People,
 * addresses, numbers and ids invented; the envelope is the contract in
 * docs/integrations/TX_MAINTENANCE_WORK_ORDERS.md.
 */

const ORGANIZATION = '10000000-0000-4000-8000-000000000001';
const CLIENT = '10000000-0000-4000-8000-00000000c1e1';

const machine: AuthenticatedUser = {
  id: CLIENT,
  authUserId: 'api-key',
  organizationId: ORGANIZATION,
  displayName: 'TX Maintenance',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['work-orders:manage'],
  mustChangePassword: false,
  principalType: 'API_KEY',
  apiClientId: CLIENT,
};

const property = {
  id: '20000000-0000-4000-8000-000000000001',
  organizationId: ORGANIZATION,
  externalId: '465764359',
  name: '123 Demo St',
  addressLine1: '123 Demo St',
  addressLine2: null,
  city: 'Houston',
  state: 'TX',
  postalCode: '77001',
  portfolio: { id: 'portfolio-1', name: 'Demo Portfolio', isActive: true },
  isActive: true,
};

function envelope(
  overrides: Partial<WorkOrderHandoff['work_order']> = {},
  rest: Partial<WorkOrderHandoff> = {},
): WorkOrderHandoff {
  return {
    idempotency_key: 'tx-maintenance:work-order:2864',
    source_system: 'tx-maintenance',
    work_order: {
      id: 2864,
      number: 43761,
      propertyware_id: '4377411585',
      source: null,
      is_crystal_creek: false,
      status: 'Open',
      service_status: 'Assigned - Waiting on Scheduling',
      local_status: 'Updated',
      priority: 'Medium',
      is_emergency: false,
      category: 'HVAC',
      type: 'Repair',
      description: 'AC not cooling since Monday',
      specific_location: 'Upstairs unit',
      authorized_to_enter: 'Yes',
      zone: '2',
      created_date: '2026-11-11T14:02:00+00:00',
      approved_date: null,
      date_to_enter: null,
      scheduled_end_date: null,
      completed_date: null,
      jobber: {
        job_gid: 'Z2lkOi8vSm9iYmVyL0pvYi8x',
        web_uri: 'https://secure.getjobber.com/jobs/1',
      },
      url: 'https://maintenance.example.test/work_orders/2864/details',
      ...overrides,
    },
    property: {
      propertyware_building_id: '465764359',
      propertyware_unit_id: null,
      propertyware_lease_id: null,
      portfolio_id: '1102',
      name: '123 Demo St',
      address: '123 Demo St',
      address_cont: null,
      city: 'Houston',
      state: 'TX',
      postal_code: '77001',
      latitude: 29.76,
      longitude: -95.36,
      location: 'DEMO | 123DEMOST',
    },
    outside_customer: null,
    occupied: true,
    tenants: [{ name: 'Pat Tenant', phone: '+15125550100', email: 'pat@example.com' }],
    vendors: [
      { propertyware_id: '246120584', name: 'Texas Home Maintenance Pros', in_house: true },
      { propertyware_id: '111', name: 'Southwinds Electric LLC', in_house: false },
    ],
    ...rest,
  };
}

function build({
  existing = null,
  building = property,
}: {
  existing?: { id: string; status: InspectionStatus } | null;
  building?: typeof property | null;
} = {}) {
  const tx = {
    propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(building) },
    propertywareUnit: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    propertywareLease: { findFirst: jest.fn().mockResolvedValue(null) },
    propertyArea: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'area-1', category: 'OTHER', source: 'MANUAL' }]),
    },
    inspection: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'visit-1' }),
      update: jest.fn().mockResolvedValue({ id: existing?.id ?? 'visit-1' }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const prisma = {
    workOrderImport: {
      upsert: jest.fn().mockResolvedValue({ id: 'import-1' }),
      update: jest.fn().mockResolvedValue({ id: 'import-1' }),
    },
    inspection: { findFirst: jest.fn().mockResolvedValue(existing) },
    propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(building) },
    propertywareUnit: { findFirst: jest.fn().mockResolvedValue(null) },
    propertywareLease: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  return { service: new WorkOrderIntakeService(prisma as never), tx, prisma };
}

describe('receiving a work order from the maintenance app', () => {
  it('stages the envelope, files a maintenance visit on the Propertyware building, and answers with its id', async () => {
    const { service, tx, prisma } = build();

    const answer = await service.receive(machine, envelope());

    expect(answer).toEqual({ id: 'visit-1', importId: 'import-1', outcome: 'created' });
    // Staged before anything else, on the sender's key, keeping the whole envelope.
    expect(prisma.workOrderImport.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_sourceSystem_externalKey: {
            organizationId: ORGANIZATION,
            sourceSystem: 'tx-maintenance',
            externalKey: 'tx-maintenance:work-order:2864',
          },
        },
      }),
    );
    // The building is found by the Propertyware id the sync already holds.
    expect(prisma.propertywareBuilding.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceSystem: 'propertyware',
          externalId: '465764359',
          isActive: true,
        }),
      }),
    );
    const data = tx.inspection.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      organizationId: ORGANIZATION,
      propertywareBuildingId: property.id,
      inspectionType: InspectionType.MAINTENANCE,
      source: InspectionSource.WORK_ORDER,
      workOrderKey: 'tx-maintenance:work-order:2864',
      workOrderNumber: 43761,
      jobberJobId: 'Z2lkOi8vSm9iYmVyL0pvYi8x',
      priority: 'STANDARD',
      createdById: null,
      allowTechnicianAreaCapture: true,
    });
    expect(data.internalNotes).toContain('Work order #43761');
    expect(data.internalNotes).toContain('AC not cooling since Monday');
    expect(data.internalNotes).toContain('Pat Tenant +15125550100');
    // No guessed layout for a repair: the approved areas as they are, nothing seeded.
    expect(data.areas).toEqual({ create: [{ propertyAreaId: 'area-1' }] });
    // The machine is the actor, never a user that does not exist.
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'WORK_ORDER_RECEIVED',
          actorUserId: null,
          actorApiClientId: CLIENT,
        }),
      }),
    );
    expect(prisma.workOrderImport.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PROCESSED', inspectionId: 'visit-1' }),
      }),
    );
  });

  it('does not refuse a second repair at the same property on the same day', async () => {
    const { service, tx } = build();

    await service.receive(machine, envelope());

    // The same-day duplicate rule reads inspections; a work order never does.
    expect(tx.inspection.findFirst).not.toHaveBeenCalled();
  });

  it('updates the visit it already made when the same key arrives again', async () => {
    const existing = { id: 'visit-9', status: InspectionStatus.SCHEDULED };
    const { service, tx, prisma } = build({ existing });

    const answer = await service.receive(
      machine,
      envelope({ is_emergency: true, description: 'Now no cooling at all' }),
    );

    expect(answer).toEqual({ id: 'visit-9', importId: 'import-1', outcome: 'updated' });
    expect(tx.inspection.create).not.toHaveBeenCalled();
    expect(tx.inspection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'visit-9' },
        data: expect.objectContaining({
          priority: 'HIGH',
          internalNotes: expect.stringContaining('Now no cooling at all'),
        }),
      }),
    );
    expect(prisma.workOrderImport.upsert.mock.calls[0][0].update).toMatchObject({
      receivedCount: { increment: 1 },
    });
  });

  it('cancels a scheduled visit when the work order closes, and leaves a started one alone', async () => {
    const scheduled = build({ existing: { id: 'visit-9', status: InspectionStatus.SCHEDULED } });
    const cancelled = await scheduled.service.receive(machine, envelope({ status: 'Closed' }));
    expect(cancelled.outcome).toBe('cancelled');
    expect(scheduled.tx.inspection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'visit-9' },
        data: { status: InspectionStatus.CANCELLED },
      }),
    );
    expect(scheduled.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'WORK_ORDER_CANCELLED' }),
      }),
    );

    const started = build({ existing: { id: 'visit-9', status: InspectionStatus.IN_PROGRESS } });
    const left = await started.service.receive(machine, envelope({ status: 'Canceled By Tenant' }));
    expect(left.outcome).toBe('unchanged');
    expect(started.tx.inspection.update).not.toHaveBeenCalled();
  });

  it('files nothing for a work order that was already closed the first time it was seen', async () => {
    const { service, tx } = build();

    const answer = await service.receive(machine, envelope({ status: 'Closed' }));

    expect(answer).toEqual({ id: null, importId: 'import-1', outcome: 'ignored_closed' });
    expect(tx.inspection.create).not.toHaveBeenCalled();
  });

  it('refuses a building this app has never synced, with a code the sender can show', async () => {
    const { service, prisma } = build({ building: null });

    await expect(service.receive(machine, envelope())).rejects.toMatchObject({
      code: 'WORK_ORDER_PROPERTY_UNKNOWN',
      getStatus: expect.any(Function),
    } satisfies Partial<ApplicationError>);
    expect(prisma.workOrderImport.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          failureCode: 'WORK_ORDER_PROPERTY_UNKNOWN',
        }),
      }),
    );
  });

  it('refuses a Crystal Creek Air job at a home that is not a Propertyware property', async () => {
    const { service } = build();

    await expect(
      service.receive(
        machine,
        envelope(
          { is_crystal_creek: true, number: 7, propertyware_id: null },
          {
            property: null,
            outside_customer: {
              name: 'Pat Customer',
              phone: '+15125550100',
              email: null,
              address: '1234 Oak St, Cypress, TX 77429',
              street: '1234 Oak St',
              city: 'Cypress',
              state: 'TX',
              postal_code: '77429',
            },
            tenants: [],
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'WORK_ORDER_OUTSIDE_PROPERTY' });
  });

  it('refuses an envelope that does not match the contract, naming the fields', async () => {
    const { service, prisma } = build();

    await expect(
      service.receive(machine, { idempotency_key: '', work_order: {} }),
    ).rejects.toMatchObject({
      code: 'WORK_ORDER_INVALID',
      details: expect.arrayContaining([expect.stringContaining('idempotency_key')]),
    });
    // Nothing is staged for an envelope that cannot be read.
    expect(prisma.workOrderImport.upsert).not.toHaveBeenCalled();
  });

  it('drops fields it has not met rather than refusing them', async () => {
    const { service } = build();

    const answer = await service.receive(machine, {
      ...envelope(),
      a_new_field: 'from a newer sender',
    });

    expect(answer.outcome).toBe('created');
  });
});

describe('reading the work order', () => {
  it('types pest control by category or by the in-house vendor, and everything else as maintenance', () => {
    expect(inspectionTypeFor(envelope())).toBe(InspectionType.MAINTENANCE);
    expect(inspectionTypeFor(envelope({ category: 'Pest Control' }))).toBe(
      InspectionType.PEST_CONTROL,
    );
    expect(
      inspectionTypeFor(
        envelope(
          { category: 'General Maintenance' },
          {
            vendors: [
              {
                propertyware_id: '4329930755',
                name: 'Crystal Creek Pest Control LLC',
                in_house: true,
              },
            ],
          },
        ),
      ),
    ).toBe(InspectionType.PEST_CONTROL);
  });

  it('raises the priority for an emergency or a high work order only', () => {
    expect(priorityFor(envelope())).toBe('STANDARD');
    expect(priorityFor(envelope({ is_emergency: true }))).toBe('HIGH');
    expect(priorityFor(envelope({ priority: 'High' }))).toBe('HIGH');
    expect(priorityFor(envelope({ priority: 'Low', is_emergency: null }))).toBe('STANDARD');
  });

  it('books the day the tenant allowed entry when it is still ahead, else the day it arrived', () => {
    const today = new Date('2026-11-12T20:00:00Z');
    expect(scheduledDayFor(envelope(), today).toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(
      scheduledDayFor(
        envelope({ date_to_enter: '2026-11-15T00:00:00+00:00' }),
        today,
      ).toISOString(),
    ).toBe('2026-11-15T00:00:00.000Z');
    // A date already past is no appointment; it arrived today.
    expect(
      scheduledDayFor(
        envelope({ date_to_enter: '2026-11-01T00:00:00+00:00' }),
        today,
      ).toISOString(),
    ).toBe('2026-11-12T00:00:00.000Z');
  });

  it('writes the notes the technician needs, with the links back', () => {
    const notes = notesFor(envelope({ is_emergency: true }));

    expect(notes.split('\n')[0]).toBe('Work order #43761 (Propertyware 4377411585)');
    expect(notes).toContain('HVAC · Repair');
    expect(notes).toContain('EMERGENCY');
    expect(notes).toContain('Zone 2 · Occupied');
    expect(notes).toContain(
      'Vendors: Texas Home Maintenance Pros (in-house), Southwinds Electric LLC',
    );
    expect(notes).toContain('Specific location: Upstairs unit');
    expect(notes).toContain(
      'Maintenance app: https://maintenance.example.test/work_orders/2864/details',
    );
    expect(notes).toContain('Jobber: https://secure.getjobber.com/jobs/1');
  });

  it('writes the estimate, the owner approval with its quotes, and the Notes tab into the visit notes (2026-11-19)', () => {
    const notes = notesFor(
      envelope(
        { cost_estimate: 450 },
        {
          notes: [
            {
              subject: 'Tenant call',
              body: 'Light out a week',
              author: 'Maria',
              date: '2026-11-09T00:00:00+00:00',
              is_private: false,
            },
            {
              subject: null,
              body: 'Owner prefers mornings',
              author: null,
              date: null,
              is_private: true,
            },
          ],
          approval: {
            rule: 'owner_approved_in_messages',
            threshold: 300,
            estimate: 450,
            recorded_by: null,
            recorded_at: null,
            ai_confidence: 92,
            ai_read_at: '2026-11-19T15:04:00+00:00',
            summary:
              'Owner approved the hallway light by text on 2026-11-10; declined the door; did not mention the lawn.',
            problems: [
              {
                item: 'hallway light',
                decision: 'approved',
                evidence: 'Go ahead with the light. — owner, 2026-11-10 14:02 (SMS)',
              },
              {
                item: 'front door',
                decision: 'declined',
                evidence: 'Hold off on the door for now. — owner, 2026-11-10 14:02 (SMS)',
              },
              { item: 'lawn', decision: 'not_mentioned', evidence: null },
            ],
          },
        },
      ),
    );

    expect(notes).toContain('Estimate: $450.00');
    expect(notes).toContain('Owner approval: read from messages by AI (92%)');
    expect(notes).toContain('Owner approved the hallway light by text on 2026-11-10');
    expect(notes).toContain(
      '- hallway light: APPROVED — "Go ahead with the light. — owner, 2026-11-10 14:02 (SMS)"',
    );
    expect(notes).toContain('- front door: declined — "Hold off on the door for now.');
    expect(notes).toContain('- lawn: not mentioned');
    expect(notes).toContain('Notes:');
    expect(notes).toContain('- 2026-11-09 Maria, Tenant call: Light out a week');
    expect(notes).toContain('- (private) Owner prefers mornings');
  });

  it('files an envelope without the new fields exactly as before', () => {
    expect(workOrderHandoffSchema.safeParse(envelope()).success).toBe(true);
    expect(notesFor(envelope())).not.toContain('Owner approval');
  });
});
