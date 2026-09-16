import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianLocationService } from '../src/technician/technician-location.service';
import { TechnicianLocationStatusDto } from '../src/technician/technician.dto';
import { TrackingStatusStore } from '../src/technician/tracking-status.store';

/**
 * How a phone says it is recording, kept and shown beside its position.
 *
 * Twice a technician's marker sat still through a drive with nothing to say
 * why: recording off, a permission refused, an old update, fixes stuck on the
 * handset all looked identical from the office.
 */

const moses = {
  id: '00000000-0000-4000-8000-00000000000a',
  organizationId: '00000000-0000-4000-8000-000000000002',
} as AuthenticatedUser;

const report = (over: Record<string, unknown> = {}) => ({
  recording: 'BACKGROUND',
  stoppedBecause: null,
  foregroundPermission: 'GRANTED',
  backgroundPermission: 'DENIED',
  servicesEnabled: true,
  platform: 'android',
  appVersion: '1.1.0',
  updateId: '01a0a6f1-a192-7511-84aa-4b3536c7220d',
  appState: 'background',
  lastFixAt: '2026-09-16T15:39:02.000Z',
  queuedFixes: 3,
  ...over,
});

const row = (technicianId: string) => ({
  id: `ping-${technicianId}`,
  technicianId,
  latitude: { toNumber: () => 30.0159 },
  longitude: { toNumber: () => -95.1712 },
  accuracyMeters: 6,
  batteryPercent: null,
  headingDegrees: null,
  speedMetersPerSecond: null,
  recordedAt: new Date('2026-09-16T15:39:02.000Z'),
  technician: { id: technicianId, displayName: 'Moses Rodriguez' },
});

function build() {
  const store = new TrackingStatusStore();
  const prisma = {
    technicianLocationPing: {
      groupBy: jest.fn().mockResolvedValue([
        { technicianId: moses.id, _max: { recordedAt: new Date('2026-09-16T15:39:02.000Z') } },
        { technicianId: 'kevin', _max: { recordedAt: new Date('2026-09-16T15:30:00.000Z') } },
      ]),
      findMany: jest.fn().mockResolvedValue([row(moses.id), row('kevin')]),
    },
  };
  const service = new TechnicianLocationService(prisma as never, undefined, undefined, store);
  return { service, store };
}

describe('a phone reporting how it records', () => {
  it('is shown with that technician’s position, and only theirs', async () => {
    const { service } = build();

    service.recordTrackingStatus(moses, report() as never);
    const positions = await service.latestPositions(moses);

    const own = positions.find((position) => position.technicianId === moses.id);
    expect(own?.tracking).toMatchObject({
      recording: 'BACKGROUND',
      backgroundPermission: 'DENIED',
      platform: 'android',
      queuedFixes: 3,
    });
    expect(own?.tracking?.reportedAt).toEqual(expect.any(String));
    // Nobody reported for Kevin: unknown, not assumed healthy.
    expect(positions.find((position) => position.technicianId === 'kevin')?.tracking).toBeNull();
  });

  it('replaces the last report rather than keeping a history', () => {
    const { service, store } = build();

    service.recordTrackingStatus(moses, report() as never);
    service.recordTrackingStatus(moses, report({ recording: 'OFF', stoppedBecause: 'PAUSED' }) as never);

    expect(store.get(moses.id)).toMatchObject({ recording: 'OFF', stoppedBecause: 'PAUSED' });
  });
});

describe('what a phone may report', () => {
  const errorsFor = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(TechnicianLocationStatusDto, body), { whitelist: true }))
      .map((error) => error.property);

  it('accepts what the app sends', async () => {
    expect(await errorsFor(report())).toEqual([]);
  });

  it('accepts the nulls a phone sends when it cannot say', async () => {
    expect(
      await errorsFor(
        report({ servicesEnabled: null, appVersion: null, updateId: null, lastFixAt: null }),
      ),
    ).toEqual([]);
  });

  it('refuses a recording mode or permission it does not know', async () => {
    expect(await errorsFor(report({ recording: 'SOMETIMES' }))).toContain('recording');
    expect(await errorsFor(report({ backgroundPermission: 'MAYBE' }))).toContain(
      'backgroundPermission',
    );
  });

  it('bounds the free text, which the office reads as written', async () => {
    expect(await errorsFor(report({ appVersion: 'x'.repeat(41) }))).toContain('appVersion');
  });
});
