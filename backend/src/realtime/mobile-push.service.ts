import { Inject, Injectable, Logger } from '@nestjs/common';

import type { AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface MobilePushDeviceInput {
  expoPushToken: string;
  platform: 'ios' | 'android';
}

@Injectable()
export class MobilePushService {
  private readonly logger = new Logger(MobilePushService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  register(user: AuthenticatedUser, input: MobilePushDeviceInput) {
    return this.prisma.mobilePushDevice.upsert({
      where: { expoPushToken: input.expoPushToken },
      update: {
        userProfileId: user.id,
        platform: input.platform,
        isActive: true,
        lastSeenAt: new Date(),
      },
      create: {
        userProfileId: user.id,
        expoPushToken: input.expoPushToken,
        platform: input.platform,
      },
      select: { id: true, platform: true, isActive: true },
    });
  }

  async unregister(user: AuthenticatedUser, expoPushToken: string) {
    await this.prisma.mobilePushDevice.updateMany({
      where: { userProfileId: user.id, expoPushToken },
      data: { isActive: false },
    });
  }

  /**
   * Copy for the events a technician has to hear about with the app closed.
   *
   * Only kinds that put work back in their hands. The queue-churn kinds still
   * reach an open app over the socket; pushing every one of them is how people
   * learn to swipe the notification away without reading it.
   *
   * Mirrors the handset's own local-notification list, which fires instead of
   * this when no push token is registered.
   */
  private static readonly COPY: Partial<
    Record<string, { title: string; body: string; channelId: string }>
  > = {
    ASSIGNED: {
      title: 'New inspection assigned',
      body: 'A new inspection is ready in your TexasRenters workspace.',
      channelId: 'assignments',
    },
    REOPENED: {
      title: 'Inspection sent back',
      body: 'The office returned an inspection to you. Open it to read why.',
      channelId: 'assignments',
    },
    EVIDENCE_REQUESTED: {
      title: 'More evidence requested',
      body: 'The office asked for more evidence on one of your areas.',
      channelId: 'assignments',
    },
  };

  /**
   * Delivers one event to every device this technician has registered.
   *
   * Best effort throughout: a push that cannot be delivered must never fail the
   * admin action that triggered it, so every path here logs and returns.
   */
  async send(kind: string, technicianId: string, inspectionId: string) {
    const copy = MobilePushService.COPY[kind];
    if (!copy) return;
    const devices = await this.prisma.mobilePushDevice.findMany({
      where: { userProfileId: technicianId, isActive: true },
      select: { expoPushToken: true },
    });
    if (devices.length === 0) return;
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(
          devices.map(({ expoPushToken }) => ({
            to: expoPushToken,
            ...copy,
            sound: 'default',
            data: { inspectionId, kind },
          })),
        ),
      });
      if (!response.ok) throw new Error(`Expo push service returned ${response.status}.`);
      await this.retireUnregistered(devices, response);
    } catch (error) {
      this.logger.warn({
        event: 'technician_push_failed',
        kind,
        technicianId,
        inspectionId,
        reason: error instanceof Error ? error.message : 'Unknown push delivery error',
      });
    }
  }

  /**
   * Deactivates tokens Expo says no longer exist.
   *
   * A 200 from Expo means the batch was accepted, not that it was delivered:
   * per-ticket errors ride in the body. `DeviceNotRegistered` is the one that
   * matters — the app was uninstalled or the token rotated — and without this
   * that row stays active forever, so every future push to that technician is
   * silently swallowed. Which is indistinguishable, from their side, from the
   * notification never being sent.
   */
  private async retireUnregistered(
    devices: { expoPushToken: string }[],
    response: Response,
  ) {
    const payload = (await response.json().catch(() => null)) as {
      data?: { status?: string; details?: { error?: string } }[];
    } | null;
    const dead = (payload?.data ?? [])
      .map((ticket, index) =>
        ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered'
          ? devices[index]?.expoPushToken
          : undefined,
      )
      .filter((token): token is string => Boolean(token));
    if (!dead.length) return;
    await this.prisma.mobilePushDevice.updateMany({
      where: { expoPushToken: { in: dead } },
      data: { isActive: false },
    });
    this.logger.log({ event: 'push_devices_retired', count: dead.length });
  }
}
