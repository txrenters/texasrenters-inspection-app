import { performance } from 'node:perf_hooks';

import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from './prisma.service';

@Injectable()
export class DatabaseHealthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async check() {
    const startedAt = performance.now();
    await this.prisma.$queryRawUnsafe('SELECT 1');
    return {
      status: 'ready' as const,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      startup: this.prisma.readiness(),
    };
  }
}
