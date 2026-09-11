import { TechnicianLocationService } from '../src/technician/technician-location.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * A retried upload must not write the position twice.
 *
 * The queue on the handset has always generated a stable id per fix — its own
 * comment says it is "stable across retries, so a duplicate send is
 * recognisable" — and the server never received it. So a batch whose response
 * was lost got sent again and written again. Production holds positions stored
 * twice, and one stored three times: identical coordinates, three separate
 * uploads, one moment in time.
 */

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
} as AuthenticatedUser;

const fix = (over: Record<string, unknown> = {}) => ({
  deviceFixId: 'fix-abc-123',
  latitude: 30.015878,
  longitude: -95.602839,
  recordedAt: '2026-09-11T20:43:22.995Z',
  accuracyMeters: 38,
  ...over,
});

function build() {
  const prisma = {
    technicianLocationPing: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  return { service: new TechnicianLocationService(prisma as never), prisma };
}

const writeArgs = (prisma: { technicianLocationPing: { createMany: jest.Mock } }) =>
  prisma.technicianLocationPing.createMany.mock.calls[0][0] as {
    skipDuplicates?: boolean;
    data: { deviceFixId: string | null }[];
  };

describe('storing a batch of fixes', () => {
  it('asks the database to skip one it already has', async () => {
    const { service, prisma } = build();

    await service.record(user, { fixes: [fix()] } as never);

    expect(writeArgs(prisma).skipDuplicates).toBe(true);
  });

  it('keeps the id the handset gave, which is what makes that work', async () => {
    const { service, prisma } = build();

    await service.record(user, { fixes: [fix()] } as never);

    expect(writeArgs(prisma).data[0].deviceFixId).toBe('fix-abc-123');
  });

  it('stores a null for a handset that sends no id', async () => {
    /**
     * A queue written by a build older than this carries no id. Those rows are
     * neither deduplicated nor refused: Postgres treats NULLs as distinct in a
     * unique index, so they behave exactly as they did before.
     */
    const { service, prisma } = build();

    await service.record(user, { fixes: [fix({ deviceFixId: undefined })] } as never);

    expect(writeArgs(prisma).data[0].deviceFixId).toBeNull();
  });

  it('still reports what it accepted', async () => {
    // The count is what tells a handset its queue drained. A silent write is
    // how a queue never empties.
    const { service } = build();

    const result = await service.record(user, { fixes: [fix(), fix({ deviceFixId: 'b' })] } as never);

    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(0);
  });
});
