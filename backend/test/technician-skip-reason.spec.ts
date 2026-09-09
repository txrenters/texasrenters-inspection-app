import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianReasonDto } from '../src/technician/technician.dto';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * Skipping a room is confirmed, not justified.
 *
 * The reason was mandatory — `@MinLength(1)`, and a multiline box the technician
 * had to fill before the button would work. Field feedback, 2026-09-09: an
 * occupied inspection is walked in about fifteen minutes, and the commonest
 * skip is a bedroom the tenant has locked, which the skip itself already says.
 *
 * A required free-text field mid-walkthrough is answered with whatever clears
 * it. "n/a" forty times a week is worse than an empty column, because an empty
 * column does not look like an answer.
 *
 * What must NOT be lost is the skip itself. That is the durable fact the report
 * and the review screen read, and it is asserted below alongside the relaxation.
 */

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-technician',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Field Technician',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

const ROOM_ID = '20000000-0000-4000-8000-000000000001';
const INSPECTION_ID = '20000000-0000-4000-8000-000000000002';

function build() {
  const update = jest.fn().mockResolvedValue({
    id: ROOM_ID,
    inspectionId: INSPECTION_ID,
    completionStatus: 'SKIPPED',
    propertyArea: { name: 'Second bedroom', isRequired: true, inspectionOrder: 2 },
    inspection: { inspectionType: 'OCCUPIED' },
    media: [],
    findings: [],
  });
  const prisma = {
    inspectionArea: {
      findFirst: jest.fn().mockResolvedValue({ id: ROOM_ID, inspectionId: INSPECTION_ID }),
      update,
    },
  };
  const service = new TechnicianService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  ) as unknown as {
    skipRoom: (user: AuthenticatedUser, id: string, reason?: string) => Promise<unknown>;
    mapRoom: (record: unknown) => unknown;
  };
  // `mapRoom` shapes a full Prisma row this test has no interest in building.
  service.mapRoom = (record) => record;
  return { service, update };
}

async function validationErrors(body: Record<string, unknown>) {
  return validate(plainToInstance(TechnicianReasonDto, body));
}

describe('what the API asks for when a room is skipped', () => {
  it('accepts a skip with no reason at all', async () => {
    expect(await validationErrors({})).toEqual([]);
  });

  it('still accepts one with a reason, and still caps its length', async () => {
    expect(await validationErrors({ reason: 'Tenant had the bedroom locked.' })).toEqual([]);
    expect(await validationErrors({ reason: 'x'.repeat(501) })).not.toEqual([]);
  });

  it('rejects a reason that is not text', async () => {
    // Optional means "may be absent", not "may be anything".
    expect(await validationErrors({ reason: 42 })).not.toEqual([]);
  });
});

describe('what is recorded when a room is skipped', () => {
  it('records the skip itself, which is the fact that matters', async () => {
    const { service, update } = build();
    await service.skipRoom(technician, ROOM_ID);

    const written = update.mock.calls[0][0].data;
    expect(written.completionStatus).toBe('SKIPPED');
    // Counted as finished, so the inspection can be submitted without it —
    // `completeInspection` accepts COMPLETED or SKIPPED and nothing else.
    expect(written.completedAt).toBeInstanceOf(Date);
  });

  it('writes null rather than an empty string when nothing was said', async () => {
    // A reader has to be able to tell "no reason given" from "a reason that is
    // blank". An empty string is the second, and it is never what happened.
    const { service, update } = build();
    await service.skipRoom(technician, ROOM_ID);
    expect(update.mock.calls[0][0].data.skipReason).toBeNull();
  });

  it('keeps a reason when the technician gave one', async () => {
    const { service, update } = build();
    await service.skipRoom(technician, ROOM_ID, '  Tenant had the bedroom locked.  ');
    expect(update.mock.calls[0][0].data.skipReason).toBe('Tenant had the bedroom locked.');
  });

  it('treats whitespace as nothing said', async () => {
    const { service, update } = build();
    await service.skipRoom(technician, ROOM_ID, '   ');
    expect(update.mock.calls[0][0].data.skipReason).toBeNull();
  });
});
