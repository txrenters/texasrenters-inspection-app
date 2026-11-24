import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianLocationService } from '../src/technician/technician-location.service';
import { TechnicianLocationStatusDto } from '../src/technician/technician.dto';

/**
 * Location is stored only from office hours (the office, 2026-11-24): Monday to
 * Friday, 7 AM to 6 PM Texas time, never on a weekend or a federal holiday.
 *
 * The phone stops recording outside them. This is the API's half: a phone
 * still on an older build keeps recording and sending all weekend until its
 * update arrives, and nothing it sends from outside office hours is kept.
 */

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
} as AuthenticatedUser;

const fix = (deviceFixId: string, recordedAt: string) => ({
  deviceFixId,
  latitude: 30.002178,
  longitude: -95.586739,
  recordedAt,
  accuracyMeters: 8,
});

const FRIDAY_AFTERNOON = '2026-11-20T21:00:00.000Z'; // 3 PM
const FRIDAY_NIGHT = '2026-11-21T03:00:00.000Z'; // 9 PM
const SATURDAY_NOON = '2026-11-21T18:00:00.000Z';
const VETERANS_DAY_NOON = '2026-11-11T18:00:00.000Z';

function build() {
  const prisma = {
    technicianLocationPing: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  return { service: new TechnicianLocationService(prisma as never), prisma };
}

afterEach(() => jest.restoreAllMocks());

describe('a fix taken outside office hours', () => {
  it('is never stored, at the weekend or after 6 PM or on a holiday', async () => {
    const { service, prisma } = build();

    const result = await service.record(user, {
      fixes: [
        fix('night', FRIDAY_NIGHT),
        fix('saturday', SATURDAY_NOON),
        fix('veterans-day', VETERANS_DAY_NOON),
      ],
    } as never);

    expect(result).toEqual({ accepted: 0, rejected: 3 });
    expect(prisma.technicianLocationPing.createMany).not.toHaveBeenCalled();
  });

  it('leaves the office-hours fixes of the same batch stored', async () => {
    const { service, prisma } = build();

    const result = await service.record(user, {
      fixes: [fix('saturday', SATURDAY_NOON), fix('friday', FRIDAY_AFTERNOON)],
    } as never);

    expect(result).toEqual({ accepted: 1, rejected: 1 });
    const written = prisma.technicianLocationPing.createMany.mock.calls[0][0] as {
      data: { deviceFixId: string }[];
    };
    expect(written.data.map((row) => row.deviceFixId)).toEqual(['friday']);
  });

  it('is not logged as a fault: older phones send them every few seconds all weekend', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = build();

    await service.record(user, { fixes: [fix('saturday', SATURDAY_NOON)] } as never);

    expect(warn).not.toHaveBeenCalled();
  });

  it('still logs a fix refused for a real fault', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = build();

    await service.record(user, {
      fixes: [fix('saturday', SATURDAY_NOON), { ...fix('bad', FRIDAY_AFTERNOON), latitude: 999 }],
    } as never);

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: 'IMPOSSIBLE_COORDINATE' }));
  });
});

describe('the phone saying it stopped for office hours', () => {
  it('is a reason the status report accepts', async () => {
    const status = plainToInstance(TechnicianLocationStatusDto, {
      recording: 'OFF',
      stoppedBecause: 'OFF_HOURS',
      foregroundPermission: 'GRANTED',
      backgroundPermission: 'GRANTED',
      platform: 'android',
      queuedFixes: 0,
    });

    expect(await validate(status)).toEqual([]);
  });
});
