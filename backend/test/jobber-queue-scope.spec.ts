import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JobberMappingService } from '../src/integrations/jobber/jobber.mapping.service';
import type { AuthenticatedUser } from '../src/common/auth';

const user = { id: 'u1', organizationId: 'org-1' } as AuthenticatedUser;

/**
 * The console reported "Properties to map (26)" when one property was blocking
 * one inspection. Two separate causes, one per describe below.
 */
describe('what the mapping queue counts', () => {
  const serviceWith = () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new JobberMappingService({ jobberPropertyLink: { findMany } } as never);
    return { service, findMany };
  };

  it('lists only links a visit is still waiting on', async () => {
    // 20 of 26 entries were behind visits already completed in Jobber, which
    // processVisit skips before it ever re-resolves a property — so no amount
    // of mapping would have changed anything about them.
    const { service, findMany } = serviceWith();
    await service.queue(user);

    const where = findMany.mock.calls[0][0].where as {
      visitImports: { some: { status: { in: string[] } } };
    };
    expect(where.visitImports.some.status.in).toEqual(['PENDING', 'UNMATCHED_PROPERTY']);
  });

  it('counts held visits the same way it filters links', async () => {
    // An unfiltered count says "12 visits held" about a property whose twelve
    // visits all happened months ago — the same overstatement one level down.
    const { service, findMany } = serviceWith();
    await service.queue(user);

    const count = findMany.mock.calls[0][0].select._count.select.visitImports as {
      where: { status: { in: string[] } };
    };
    expect(count.where.status.in).toEqual(['PENDING', 'UNMATCHED_PROPERTY']);
  });

  it('still only asks about links that need a person at all', async () => {
    const { service, findMany } = serviceWith();
    await service.queue(user);
    const where = findMany.mock.calls[0][0].where as { status: { in: string[] } };
    expect(where.status.in).toEqual(['UNMATCHED', 'AMBIGUOUS']);
  });
});

describe('when a visit type is decided', () => {
  const WORKER = readFileSync(
    join(__dirname, '..', 'src', 'workers', 'jobber-sync', 'jobber-sync.worker.ts'),
    'utf8',
  );

  it('resolves the type before resolving the property', () => {
    // The ordering is the whole fix. Resolving the property first meant a
    // filter delivery at an unmapped address created a mapping-queue entry, so
    // the console listed properties to map on behalf of work it was never going
    // to import. Five of six live entries were exactly that.
    const type = WORKER.indexOf('const type = resolveVisitType(visit.title, rules)');
    const property = WORKER.indexOf('await this.mapping.resolveProperty(');
    expect(type).toBeGreaterThan(-1);
    expect(property).toBeGreaterThan(type);
  });

  it('attaches no property link to a visit it will never import', () => {
    // The link is what puts a property in the queue. A type we do not sync must
    // not create one.
    const notSynced = WORKER.indexOf('JobberVisitImportStatus.SKIPPED_NOT_SYNCED');
    const property = WORKER.indexOf('await this.mapping.resolveProperty(');
    expect(notSynced).toBeLessThan(property);
    // Everything from the type check to the property lookup, which must not
    // mention a link because none exists yet.
    expect(WORKER.slice(notSynced, property)).not.toContain('link.id');
  });
});
