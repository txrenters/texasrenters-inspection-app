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

  async sendAssignment(technicianId: string, inspectionId: string) {
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
            title: 'New inspection assigned',
            body: 'A new inspection is ready in your TexasRenters workspace.',
            sound: 'default',
            channelId: 'assignments',
            data: { inspectionId },
          })),
        ),
      });
      if (!response.ok) throw new Error(`Expo push service returned ${response.status}.`);
    } catch (error) {
      this.logger.warn({
        event: 'assignment_push_failed',
        technicianId,
        inspectionId,
        reason: error instanceof Error ? error.message : 'Unknown push delivery error',
      });
    }
  }
}
