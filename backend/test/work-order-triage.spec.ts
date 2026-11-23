import { InspectionStatus, WorkOrderTriageOutcome } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import type { WorkOrderHandoff } from '../src/work-orders/work-order-handoff.schema';
import {
  parseReading,
  triageText,
  WorkOrderTriageService,
} from '../src/work-orders/work-order-triage.service';

/**
 * Reading a work order and putting it on the technician who fits. People,
 * addresses and skills invented; the AI provider is a stubbed fetch.
 */

const ORGANIZATION = '10000000-0000-4000-8000-000000000001';
const VISIT = '30000000-0000-4000-8000-000000000001';

const machine: AuthenticatedUser = {
  id: 'client-1',
  authUserId: 'api-key',
  organizationId: ORGANIZATION,
  displayName: 'TX Maintenance',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['work-orders:manage'],
  mustChangePassword: false,
  principalType: 'API_KEY',
  apiClientId: 'client-1',
};

const catalog = [
  { id: 'skill-faucet', key: 'faucet-leak', label: 'Faucet Leak' },
  { id: 'skill-heater', key: 'water-heater', label: 'Water heater' },
];

function handoff(description = 'Kitchen faucet drips constantly'): WorkOrderHandoff {
  return {
    idempotency_key: 'tx-maintenance:work-order:2864',
    source_system: 'tx-maintenance',
    work_order: {
      id: 2864,
      number: 2864,
      is_crystal_creek: false,
      is_emergency: false,
      category: 'Plumbing',
      type: 'Repair',
      description,
      jobber: {},
    },
    property: null,
    outside_customer: null,
    occupied: true,
    tenants: [{ name: 'Pat Tenant', phone: '555-0100', email: 'pat@example.com' }],
    vendors: [],
    notes: [{ body: 'Tenant says it started Monday', is_private: false }],
  } as WorkOrderHandoff;
}

function aiAnswers(...answers: string[]) {
  const fetchMock = jest.fn();
  for (const answer of answers)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: answer }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function harness(options: { assigned?: boolean; grants?: { technicianId: string; skillId: string; level: string; note: string | null }[] } = {}) {
  let triageRow: Record<string, unknown> | null = null;
  const prisma = {
    inspection: {
      findFirst: jest.fn(async () => ({
        status: InspectionStatus.SCHEDULED,
        scheduledAt: new Date('2026-11-24T00:00:00.000Z'),
        assignments: options.assigned ? [{ id: 'a-1' }] : [],
        workOrderTriage: triageRow,
      })),
    },
    technicianSkill: { findMany: jest.fn(async () => catalog) },
    userProfile: {
      findMany: jest.fn(async () => [
        { id: 'tech-kevin', displayName: 'Kevin' },
        { id: 'tech-amy', displayName: 'Amy' },
      ]),
    },
    technicianSkillGrant: {
      findMany: jest.fn(async () =>
        options.grants ?? [{ technicianId: 'tech-kevin', skillId: 'skill-faucet', level: 'FULL', note: null }],
      ),
    },
    inspectionAssignment: { groupBy: jest.fn(async () => []) },
    workOrderTriage: {
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
        triageRow = create;
        return create;
      }),
    },
  };
  const admin = { autoAssignWorkOrder: jest.fn(async () => true) };
  const aiSettings = {
    resolve: jest.fn(async () => ({ provider: 'ANTHROPIC', modelId: 'claude-sonnet-5', apiKey: 'test' })),
    recordUsage: jest.fn(async () => undefined),
  };
  const service = new WorkOrderTriageService(prisma as never, admin as never, aiSettings as never);
  return { service, prisma, admin, aiSettings, row: () => triageRow };
}

describe('parseReading', () => {
  const keys = new Set(catalog.map((skill) => skill.key));

  it('keeps only skills in the catalog', () => {
    expect(
      parseReading('```json\n{"skills":["faucet-leak","roofing"],"scope":"MINOR","confidence":82,"summary":"Drip"}\n```', keys),
    ).toEqual({ skillKeys: ['faucet-leak'], scope: 'MINOR', confidence: 82, summary: 'Drip' });
  });

  it('refuses an answer that is not the agreed shape', () => {
    expect(parseReading('{"skills":["faucet-leak"],"scope":"HUGE","confidence":82}', keys)).toBeNull();
    expect(parseReading('I think a plumber', keys)).toBeNull();
  });
});

describe('triageText', () => {
  it('sends the problem, never the tenant', () => {
    const text = triageText(handoff());
    expect(text).toContain('Kitchen faucet drips constantly');
    expect(text).toContain('Tenant says it started Monday');
    expect(text).not.toMatch(/Pat Tenant|555-0100|pat@example\.com/);
  });
});

describe('WorkOrderTriageService', () => {
  const mode = process.env.WORK_ORDER_AUTO_ASSIGN;
  beforeEach(() => {
    process.env.WORK_ORDER_AUTO_ASSIGN = 'assign';
  });
  afterAll(() => {
    if (mode === undefined) delete process.env.WORK_ORDER_AUTO_ASSIGN;
    else process.env.WORK_ORDER_AUTO_ASSIGN = mode;
  });

  it('in the trial, names who it would assign and assigns nobody', async () => {
    delete process.env.WORK_ORDER_AUTO_ASSIGN;
    aiAnswers('{"skills":["faucet-leak"],"scope":"MINOR","confidence":90,"summary":"Dripping faucet"}');
    const { service, admin, row } = harness();
    await service.triage(machine, VISIT, handoff());
    expect(admin.autoAssignWorkOrder).not.toHaveBeenCalled();
    expect(row()).toMatchObject({
      outcome: WorkOrderTriageOutcome.SUGGESTED,
      technicianId: 'tech-kevin',
      reason: 'Would assign Kevin: Faucet Leak; minor job.',
    });
  });

  it('assigns the technician who fits', async () => {
    aiAnswers('{"skills":["faucet-leak"],"scope":"MINOR","confidence":90,"summary":"Dripping faucet"}');
    const { service, admin, row } = harness();
    await service.triage(machine, VISIT, handoff());
    expect(admin.autoAssignWorkOrder).toHaveBeenCalledWith(
      machine,
      VISIT,
      'tech-kevin',
      expect.objectContaining({ skills: ['faucet-leak'], scope: 'MINOR' }),
    );
    expect(row()).toMatchObject({
      outcome: WorkOrderTriageOutcome.ASSIGNED,
      technicianId: 'tech-kevin',
      reason: 'Kevin: Faucet Leak; minor job.',
    });
  });

  it('reads a re-send with the same text once', async () => {
    const fetchMock = aiAnswers('{"skills":["faucet-leak"],"scope":"MINOR","confidence":90,"summary":"x"}');
    const { service, admin } = harness();
    admin.autoAssignWorkOrder.mockResolvedValue(false);
    await service.triage(machine, VISIT, handoff());
    await service.triage(machine, VISIT, handoff());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads again when the work order text changes', async () => {
    const fetchMock = aiAnswers(
      '{"skills":["faucet-leak"],"scope":"MINOR","confidence":90,"summary":"x"}',
      '{"skills":["water-heater"],"scope":"MAJOR","confidence":90,"summary":"y"}',
    );
    const { service, admin } = harness();
    admin.autoAssignWorkOrder.mockResolvedValue(false);
    await service.triage(machine, VISIT, handoff());
    await service.triage(machine, VISIT, handoff('No hot water, heater tank leaking'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not read a visit that already has a technician', async () => {
    const fetchMock = aiAnswers();
    const { service, row } = harness({ assigned: true });
    await service.triage(machine, VISIT, handoff());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row()).toBeNull();
  });

  it('leaves a vague work order for the office', async () => {
    aiAnswers('{"skills":["faucet-leak"],"scope":"MINOR","confidence":40,"summary":"?"}');
    const { service, admin, row } = harness();
    await service.triage(machine, VISIT, handoff('fix it'));
    expect(admin.autoAssignWorkOrder).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ outcome: WorkOrderTriageOutcome.LOW_CONFIDENCE });
  });

  it('leaves it unassigned when nobody fits', async () => {
    aiAnswers('{"skills":["water-heater"],"scope":"MAJOR","confidence":90,"summary":"Replace heater"}');
    const { service, admin, row } = harness({
      grants: [{ technicianId: 'tech-kevin', skillId: 'skill-heater', level: 'LIMITED', note: 'MINOR REPAIRS ONLY' }],
    });
    await service.triage(machine, VISIT, handoff('Replace the water heater'));
    expect(admin.autoAssignWorkOrder).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ outcome: WorkOrderTriageOutcome.NO_FIT, technicianId: null });
  });

  it('records a failed reading instead of throwing', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as never;
    const { service, admin, row } = harness();
    await service.triage(machine, VISIT, handoff());
    expect(admin.autoAssignWorkOrder).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ outcome: WorkOrderTriageOutcome.AI_FAILED });
  });

  it('stops reading at the daily ceiling', async () => {
    const previous = process.env.WORK_ORDER_TRIAGE_DAILY_CEILING;
    process.env.WORK_ORDER_TRIAGE_DAILY_CEILING = '1';
    try {
      const fetchMock = aiAnswers('{"skills":["faucet-leak"],"scope":"MINOR","confidence":90,"summary":"x"}');
      const { service, row } = harness();
      await service.triage(machine, VISIT, handoff('first'));
      await service.triage(machine, VISIT, handoff('second, different text'));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(row()).toMatchObject({ outcome: WorkOrderTriageOutcome.DAILY_LIMIT });
    } finally {
      if (previous === undefined) delete process.env.WORK_ORDER_TRIAGE_DAILY_CEILING;
      else process.env.WORK_ORDER_TRIAGE_DAILY_CEILING = previous;
    }
  });
});
