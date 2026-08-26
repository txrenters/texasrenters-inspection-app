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
  // Added with `principalType`; these fixtures are people, not integrations.
  principalType: 'USER',
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
      service.recordObservation(technician, 'insp-1', {
        temporaryLabel: 'Brown dog',
        species: 'Dog',
      }),
    ).resolves.toEqual({ id: 'obs-1' });

    prisma.inspection.findFirst.mockResolvedValue({ id: 'insp-1', inspectionType: 'MOVE_IN' });
    await expect(
      service.recordObservation(technician, 'insp-1', {
        temporaryLabel: 'Brown dog',
        species: 'Dog',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'PET_OBSERVATION_OCCUPIED_ONLY' });
  });

  it('records one sighting when the same submission arrives twice', async () => {
    // The only technician write that appends rather than sets a value, so it
    // is the only one a queued retry could double-apply — and a duplicate pet
    // becomes a charge somebody has to argue about.
    const prisma = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue({ id: 'insp-1', inspectionType: 'OCCUPIED' }),
      },
      petObservation: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'obs-1' }),
      },
    };
    const service = new ChargeService(prisma as never);
    const submission = {
      temporaryLabel: 'Brown dog',
      species: 'Dog',
      idempotencyKey: 'key-1',
    };

    await expect(service.recordObservation(technician, 'insp-1', submission)).resolves.toEqual({
      id: 'obs-1',
    });

    // The retry finds the first one and returns it rather than erroring: a
    // repeated request is not a conflict, it is the same request.
    prisma.petObservation.findUnique.mockResolvedValue({ id: 'obs-1' });
    await expect(service.recordObservation(technician, 'insp-1', submission)).resolves.toEqual({
      id: 'obs-1',
    });
    expect(prisma.petObservation.create).toHaveBeenCalledTimes(1);
  });

  it('still records every sighting when no key is sent', async () => {
    // Omitting the key has to behave exactly as before, or an older client
    // silently loses observations.
    const prisma = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue({ id: 'insp-1', inspectionType: 'OCCUPIED' }),
      },
      petObservation: {
        findUnique: jest.fn().mockResolvedValue({ id: 'should-not-be-consulted' }),
        create: jest.fn().mockResolvedValue({ id: 'obs-2' }),
      },
    };
    const service = new ChargeService(prisma as never);
    const submission = { temporaryLabel: 'Grey cat', species: 'Cat' };

    await service.recordObservation(technician, 'insp-1', submission);
    await service.recordObservation(technician, 'insp-1', submission);
    expect(prisma.petObservation.findUnique).not.toHaveBeenCalled();
    expect(prisma.petObservation.create).toHaveBeenCalledTimes(2);
  });

  function petGroupingHarness(observations: ReturnType<typeof observation>[]) {
    const tx = {
      petCandidate: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      petObservation: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue({ id: 'insp-1' }) },
      petObservation: {
        findMany: jest.fn().mockResolvedValueOnce(observations).mockResolvedValueOnce([]),
      },
      petCandidate: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const candidates = () =>
      (tx.petCandidate.createMany.mock.calls[0]?.[0]?.data ?? []) as Record<string, unknown>[];
    return { prisma, tx, candidates };
  }

  it('groups a pet seen in three rooms into one candidate and different animals separately', async () => {
    const { prisma, candidates } = petGroupingHarness([
      observation('o1', 'Dog', 'Brown dog'),
      observation('o2', 'Dog', 'brown  dog'), // same, different whitespace/case
      observation('o3', 'Dog', 'Brown dog'),
      observation('o4', 'Cat', 'Grey cat'),
    ]);

    await new ChargeService(prisma as never).generateCandidates(user, 'insp-1');
    // Two candidates: one dog (3 observations), one cat (1 observation).
    const created = candidates();
    expect(created).toHaveLength(2);
    expect(created.map((entry) => entry.observationCount).sort()).toEqual([1, 3]);
  });

  it('links each observation to the candidate it was grouped into', async () => {
    // Ids are assigned before the insert now rather than read back from it, so
    // this guards the part that could silently go wrong: a group linked to the
    // wrong candidate would merge two animals into one charge.
    const { prisma, tx, candidates } = petGroupingHarness([
      observation('o1', 'Dog', 'Brown dog'),
      observation('o2', 'Dog', 'Brown dog'),
      observation('o3', 'Cat', 'Grey cat'),
    ]);

    await new ChargeService(prisma as never).generateCandidates(user, 'insp-1');
    const [dog, cat] = candidates();
    const links = tx.petObservation.updateMany.mock.calls.map(
      ([args]: [{ where: { id: { in: string[] } }; data: { petCandidateId: string } }]) => args,
    );
    expect(links).toHaveLength(2);
    expect(links[0].where.id.in).toEqual(['o1', 'o2']);
    expect(links[0].data.petCandidateId).toBe(dog.id);
    expect(links[1].where.id.in).toEqual(['o3']);
    expect(links[1].data.petCandidateId).toBe(cat.id);
    expect(dog.id).not.toBe(cat.id);
  });

  it('writes every candidate in one statement however many animals there are', async () => {
    // The transaction used to grow two statements per group. Against a remote
    // pooler each is a few hundred milliseconds, so enough distinct animals
    // could exhaust the budget mid-flight and roll the whole thing back.
    const many = Array.from({ length: 12 }, (_, index) =>
      observation(`o${index}`, `Species ${index}`, `Animal ${index}`),
    );
    const { prisma, tx } = petGroupingHarness(many);

    await new ChargeService(prisma as never).generateCandidates(user, 'insp-1');
    expect(tx.petCandidate.createMany).toHaveBeenCalledTimes(1);
    expect(tx.petCandidate.createMany.mock.calls[0][0].data).toHaveLength(12);
  });

  it('does not open a transaction when there is nothing to group', async () => {
    // The common case: most calls find no new observations, and an empty
    // transaction is still a round trip.
    const { prisma, tx } = petGroupingHarness([]);

    await new ChargeService(prisma as never).generateCandidates(user, 'insp-1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('configurable charges (spec §13/§14)', () => {
  it('drafts a pending charge only for confirmed unique unauthorized pets, at the configured amount', async () => {
    const createMany = { data: [] as Array<Record<string, unknown>> };
    const tx = {
      charge: {
        createMany: jest
          .fn()
          .mockImplementation((args: { data: Array<Record<string, unknown>> }) => {
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
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'charge-1', proposedAmount: 25, reason: null }),
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
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'charge-1', proposedAmount: 25, reason: null }),
      },
      $transaction: jest.fn(),
    };
    const service = new ChargeService(prisma as never);
    await expect(
      service.reviewCharge(user, 'charge-1', { decision: 'ADJUST' }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'ADJUSTED_AMOUNT_REQUIRED',
    });
  });
});
