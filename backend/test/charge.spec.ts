import { UserRole } from '@texasrenters/shared';

import { ChargeService } from '../src/admin/charge.service';
import type { AuthenticatedUser } from '../src/common/auth';

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Administrator',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
};

const technician = { organizationId: user.organizationId, userId: 'tech-1' };

function observation(id: string, species: string, label: string) {
  return {
    id,
    species,
    temporaryLabel: label,
    description: null,
    petCandidateId: null,
  };
}

describe('pet observation + dedup (spec §13)', () => {
  it('records a technician observation only for occupied inspections', async () => {
    const prisma = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue({ id: 'insp-1', inspectionType: 'OCCUPIED' }),
      },
      petObservation: { create: jest.fn().mockResolvedValue({ id: 'obs-1' }) },
    };
    const service = new ChargeService(prisma as never);
    await expect(
      service.recordObservation(technician, 'insp-1', { temporaryLabel: 'Brown dog', species: 'Dog' }),
    ).resolves.toEqual({ id: 'obs-1' });

    prisma.inspection.findFirst.mockResolvedValue({ id: 'insp-1', inspectionType: 'MOVE_IN' });
    await expect(
      service.recordObservation(technician, 'insp-1', { temporaryLabel: 'Brown dog', species: 'Dog' }),
    ).rejects.toMatchObject({ status: 422, code: 'PET_OBSERVATION_OCCUPIED_ONLY' });
  });

  it('groups a pet seen in three rooms into one candidate and different animals separately', async () => {
    const created: Array<{ data: Record<string, unknown> }> = [];
    const tx = {
      petCandidate: {
        create: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          created.push(args);
          return Promise.resolve({ id: `candidate-${created.length}` });
        }),
      },
      petObservation: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue({ id: 'insp-1' }) },
      petObservation: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            observation('o1', 'Dog', 'Brown dog'),
            observation('o2', 'Dog', 'brown  dog'), // same, different whitespace/case
            observation('o3', 'Dog', 'Brown dog'),
            observation('o4', 'Cat', 'Grey cat'),
          ])
          .mockResolvedValueOnce([]),
      },
      petCandidate: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = new ChargeService(prisma as never);

    await service.generateCandidates(user, 'insp-1');
    // Two candidates: one dog (3 observations), one cat (1 observation).
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.data.observationCount).sort()).toEqual([1, 3]);
  });
});

describe('configurable charges (spec §13/§14)', () => {
  it('drafts a pending charge only for confirmed unique unauthorized pets, at the configured amount', async () => {
    const createMany = { data: [] as Array<Record<string, unknown>> };
    const tx = {
      charge: {
        createMany: jest.fn().mockImplementation((args: { data: Array<Record<string, unknown>> }) => {
          createMany.data = args.data;
          return Promise.resolve({ count: args.data.length });
        }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue({ id: 'insp-1' }) },
      chargeRule: {
        findFirst: jest.fn().mockResolvedValue({ amount: 25, currency: 'USD' }),
      },
      petCandidate: {
        findMany: jest.fn().mockResolvedValue([{ id: 'cand-1', label: 'Brown dog' }]),
      },
      charge: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([]) // existing charges (generate)
          .mockResolvedValueOnce([]), // listCharges at the end
      },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = new ChargeService(prisma as never);

    await service.generateCharges(user, 'insp-1');
    expect(createMany.data).toHaveLength(1);
    expect(createMany.data[0]).toMatchObject({
      chargeCode: 'UNAUTHORIZED_PET',
      status: 'PENDING_REVIEW', // never APPROVED — the system does not finalize
      source: 'SYSTEM',
      unitAmount: 25,
      proposedAmount: 25,
    });
    // Only confirmed unique + unauthorized candidates are queried.
    expect(prisma.petCandidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reviewStatus: 'UNIQUE_PET',
          authorizationStatus: 'UNAUTHORIZED',
        }),
      }),
    );
  });

  it('refuses to generate charges without an active rule (amount is configured, not hard-coded)', async () => {
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue({ id: 'insp-1' }) },
      chargeRule: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new ChargeService(prisma as never);
    await expect(service.generateCharges(user, 'insp-1')).rejects.toMatchObject({
      status: 409,
      code: 'CHARGE_RULE_NOT_CONFIGURED',
    });
  });

  it('finalizes a charge only through human review, recording the amount and audit', async () => {
    const tx = {
      charge: {
        update: jest.fn().mockResolvedValue({
          id: 'charge-1',
          inspectionId: 'insp-1',
          chargeCode: 'UNAUTHORIZED_PET',
          description: 'Unauthorized pet: Brown dog',
          propertyAreaId: null,
          findingId: null,
          petCandidateId: 'cand-1',
          quantity: 1,
          unitAmount: 25,
          proposedAmount: 25,
          approvedAmount: 25,
          currency: 'USD',
          status: 'APPROVED',
          source: 'SYSTEM',
          reason: null,
          reviewedAt: new Date(),
          createdAt: new Date(),
        }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      charge: {
        findFirst: jest.fn().mockResolvedValue({ id: 'charge-1', proposedAmount: 25, reason: null }),
      },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = new ChargeService(prisma as never);

    const result = await service.reviewCharge(user, 'charge-1', { decision: 'APPROVE' });
    expect(result).toMatchObject({ status: 'APPROVED', approvedAmount: 25 });
    expect(tx.charge.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'APPROVED',
          approvedAmount: 25,
          reviewedById: user.id,
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'CHARGE_APPROVED' }),
      }),
    );
  });

  it('requires an amount when adjusting a charge', async () => {
    const prisma = {
      charge: {
        findFirst: jest.fn().mockResolvedValue({ id: 'charge-1', proposedAmount: 25, reason: null }),
      },
      $transaction: jest.fn(),
    };
    const service = new ChargeService(prisma as never);
    await expect(service.reviewCharge(user, 'charge-1', { decision: 'ADJUST' })).rejects.toMatchObject({
      status: 422,
      code: 'ADJUSTED_AMOUNT_REQUIRED',
    });
  });
});
