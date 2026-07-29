import { Test } from '@nestjs/testing';

import { DatabaseHealthService } from '../database/database-health.service';
import { PrismaService } from '../database/prisma.service';
import { VerticalSliceService } from '../vertical-slice/vertical-slice.service';
import { HealthController } from './health.controller';

const prisma = { readiness: () => ({ ready: true, lastError: null }) };
const databaseHealth = { check: () => ({ status: 'ok' }) };

async function buildController(withVerticalSlice: boolean) {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: DatabaseHealthService, useValue: databaseHealth },
      ...(withVerticalSlice
        ? [{ provide: VerticalSliceService, useValue: { diagnostics: () => ({ mock: true }) } }]
        : []),
    ],
  }).compile();
  return moduleRef.get(HealthController);
}

describe('HealthController', () => {
  it('resolves without the vertical-slice stack', async () => {
    // Regression guard: app.module.ts registers VerticalSliceService only when
    // NODE_ENV !== 'production'. While this controller injected it as a required
    // dependency, every production build — including the remote-beta Docker
    // image — failed to boot with an unresolvable-dependency error.
    await expect(buildController(false)).resolves.toBeDefined();
  });

  it('reports liveness without touching the database', async () => {
    const controller = await buildController(false);
    const result = controller.health();

    expect(result.status).toBe('ok');
    expect(typeof result.timestamp).toBe('string');
  });

  it('omits provider diagnostics when the vertical-slice stack is absent', async () => {
    const controller = await buildController(false);

    expect(controller.readiness()).not.toHaveProperty('providers');
  });

  it('includes provider diagnostics when the stack is present', async () => {
    const controller = await buildController(true);

    expect(controller.readiness()).toHaveProperty('providers', { mock: true });
  });

  it('exposes no secret-shaped values in the liveness payload', async () => {
    const controller = await buildController(false);
    const serialized = JSON.stringify(controller.health());

    // The endpoint is publicly reachable through the remote-beta ngrok tunnel.
    for (const forbidden of [
      'DATABASE_URL',
      'SERVICE_ROLE',
      'SECRET',
      'TOKEN',
      'postgres://',
      'postgresql://',
    ]) {
      expect(serialized.toUpperCase()).not.toContain(forbidden.toUpperCase());
    }
  });
});
