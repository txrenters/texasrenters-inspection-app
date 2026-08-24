import 'reflect-metadata';

import { Logger } from '@nestjs/common';

import { MobilePushService } from '../src/realtime/mobile-push.service';

const TECH = '10000000-0000-4000-8000-000000000004';

function build(devices: { expoPushToken: string }[] = [{ expoPushToken: 'ExponentPushToken[a]' }]) {
  const prisma = {
    mobilePushDevice: {
      findMany: jest.fn().mockResolvedValue(devices),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  return { prisma, service: new MobilePushService(prisma as never) };
}

function respondWith(body: unknown, ok = true) {
  const fetchMock = jest.fn().mockResolvedValue({ ok, json: async () => body });
  globalThis.fetch = fetchMock as never;
  return fetchMock;
}

describe('technician push delivery', () => {
  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  /**
   * The gap this closes. Push fired for ASSIGNED alone, so a technician whose
   * app was closed heard nothing when an inspection was sent back to them or
   * when the office asked for more evidence — the two events that most need
   * acting on.
   */
  it('pushes every event that puts work back in a technician’s hands', async () => {
    for (const kind of ['ASSIGNED', 'REOPENED', 'EVIDENCE_REQUESTED', 'UPDATED']) {
      const fetchMock = respondWith({ data: [{ status: 'ok' }] });
      const { service } = build();

      await service.send(kind, TECH, 'insp-1');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [[, init]] = fetchMock.mock.calls;
      const [message] = JSON.parse(String(init.body));
      expect(message.data).toEqual({ inspectionId: 'insp-1', kind });
      expect(message.title).toBeTruthy();
    }
  });

  it('stays quiet for queue churn', async () => {
    // These still reach an open app over the socket. Pushing every one is how
    // people learn to swipe a notification away without reading it.
    //
    // UPDATED used to sit here and now pushes: it is only ever published when
    // the office adds an area to an inspection a technician is already
    // carrying, which is more rooms to walk rather than churn — and a
    // technician who has left the property needs to know before they drive
    // away, not at their next poll.
    for (const kind of ['REASSIGNED', 'UNASSIGNED', 'CANCELLED']) {
      const fetchMock = respondWith({ data: [] });
      const { prisma, service } = build();

      await service.send(kind, TECH, 'insp-1');

      expect(fetchMock).not.toHaveBeenCalled();
      // Not even a device lookup: an unpushed kind should cost nothing.
      expect(prisma.mobilePushDevice.findMany).not.toHaveBeenCalled();
    }
  });

  it('sends nothing when the technician has no registered device', async () => {
    const fetchMock = respondWith({ data: [] });
    const { service } = build([]);

    await service.send('REOPENED', TECH, 'insp-1');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retires a token Expo says no longer exists', async () => {
    /**
     * A 200 means the batch was accepted, not delivered — per-ticket errors
     * ride in the body. Left active, a dead token swallows every future push to
     * that technician, which from their side is indistinguishable from the
     * notification never being sent.
     */
    respondWith({
      data: [{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }],
    });
    const { prisma, service } = build([
      { expoPushToken: 'ExponentPushToken[live]' },
      { expoPushToken: 'ExponentPushToken[dead]' },
    ]);

    await service.send('ASSIGNED', TECH, 'insp-1');

    expect(prisma.mobilePushDevice.updateMany).toHaveBeenCalledWith({
      where: { expoPushToken: { in: ['ExponentPushToken[dead]'] } },
      data: { isActive: false },
    });
  });

  it('keeps a token whose delivery failed for any other reason', async () => {
    // A rate limit or a transient Expo fault is not a reason to stop trying to
    // reach someone's phone.
    respondWith({
      data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }],
    });
    const { prisma, service } = build();

    await service.send('ASSIGNED', TECH, 'insp-1');

    expect(prisma.mobilePushDevice.updateMany).not.toHaveBeenCalled();
  });

  /**
   * The failure that made "push does not work" unanswerable. Expo replies 200
   * and refuses every message in the body when the project has no FCM
   * credential, so a push that reached nobody was indistinguishable from a
   * delivered one — in the logs and on the handset alike. The ticket is the
   * only evidence that exists, so it has to be read.
   */
  it('logs the ticket when Expo refuses to deliver', async () => {
    respondWith({
      data: [
        {
          status: 'error',
          message: 'Unable to retrieve the FCM server key for the recipient app.',
          details: { error: 'InvalidCredentials' },
        },
      ],
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = build();

    await service.send('ASSIGNED', TECH, 'insp-1');

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'technician_push_rejected',
        tickets: [expect.objectContaining({ error: 'InvalidCredentials' })],
      }),
    );
    warn.mockRestore();
  });

  it('never lets a push failure escape to the caller', async () => {
    // The admin action that triggered this must not fail because a phone was
    // unreachable.
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('network down')) as never;
    const { service } = build();

    await expect(service.send('REOPENED', TECH, 'insp-1')).resolves.toBeUndefined();
  });
});
