import { Test } from '@nestjs/testing';

import { DatabaseHealthService } from '../database/database-health.service';
import { PrismaService } from '../database/prisma.service';
import { HealthController } from './health.controller';

const prisma = { readiness: () => ({ ready: true, lastError: null }) };
const databaseHealth = { check: () => ({ status: 'ok' }) };

async function buildController() {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: DatabaseHealthService, useValue: databaseHealth },
    ],
  }).compile();
  return moduleRef.get(HealthController);
}

describe('HealthController', () => {
  it('resolves with only its database dependencies', async () => {
    // Was a regression guard for an optional VerticalSliceService injection:
    // that stack registered only when NODE_ENV !== 'production', so requiring it
    // here broke every production boot. The stack is gone, and this now asserts
    // the simpler property that replaced it — nothing but the database.
    await expect(buildController()).resolves.toBeDefined();
  });

  it('reports liveness without touching the database', async () => {
    const controller = await buildController();
    const result = controller.health();

    expect(result.status).toBe('ok');
    expect(typeof result.timestamp).toBe('string');
  });

  it('never reports provider diagnostics', async () => {
    const controller = await buildController();

    // `providers` described the mock stack and nothing else: it reported that
    // fake transcription and analysis were "healthy" while saying nothing about
    // the credentials actually in use. A readiness probe that answers for
    // components no request touches is worse than one that stays quiet.
    expect(controller.readiness()).not.toHaveProperty('providers');
  });

  it('exposes no secret-shaped values in the liveness payload', async () => {
    const controller = await buildController();
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
