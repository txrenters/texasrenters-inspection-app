import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Test } from '@nestjs/testing';

import { preparePersistentDatabaseEnvironment } from '../src/database/database-connection';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { QueryPerformanceContext } from '../src/database/query-performance.context';

describe('database performance foundation', () => {
  it('selects an existing approved session-pooler URL for the persistent runtime', () => {
    const environment = {
      NODE_ENV: 'development',
      DATABASE_URL:
        'postgresql://user:password@aws-0-ca-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
      DIRECT_URL: 'postgresql://user:password@aws-0-ca-central-1.pooler.supabase.com:5432/postgres',
    } as NodeJS.ProcessEnv;

    expect(preparePersistentDatabaseEnvironment(environment)).toEqual({
      category: 'supabase-session-pooler',
      port: '5432',
      source: 'DIRECT_URL',
    });
    expect(new URL(environment.DATABASE_URL!).port).toBe('5432');
  });

  it('provides exactly one PrismaService instance to multiple consumers', async () => {
    const module = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();
    expect(module.get(PrismaService)).toBe(module.get(PrismaService));
    await module.close();
  });

  it('warms the connection once and disconnects during shutdown', async () => {
    const previous = process.env.DATABASE_WARMUP_ENABLED;
    process.env.DATABASE_WARMUP_ENABLED = 'true';
    const service = new PrismaService(new QueryPerformanceContext());
    const connect = jest.spyOn(service, '$connect').mockResolvedValue(undefined);
    const query = jest.spyOn(service, '$queryRawUnsafe').mockResolvedValue([{ value: 1 }]);
    const disconnect = jest.spyOn(service, '$disconnect').mockResolvedValue(undefined);
    try {
      await service.onModuleInit();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(1);
      expect(service.readiness().ready).toBe(true);
      await service.onModuleDestroy();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(service.readiness().ready).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_WARMUP_ENABLED;
      else process.env.DATABASE_WARMUP_ENABLED = previous;
    }
  });

  it('does not redeclare PrismaService in feature-module provider lists', () => {
    const modules = [
      'src/app.module.ts',
      'src/admin/admin.module.ts',
      'src/technician/technician.module.ts',
      'src/realtime/realtime.module.ts',
      'src/integrations/propertyware/propertyware.module.ts',
    ];
    for (const relative of modules) {
      const source = readFileSync(join(__dirname, '..', relative), 'utf8');
      expect(source).not.toMatch(/providers:\s*\[[^\]]*PrismaService/s);
    }
  });
});
