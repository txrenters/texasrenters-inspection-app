import { UserRole } from '@texasrenters/shared';

import { FloorPlanAdminService } from '../src/admin/floor-plan-admin.service';
import type { AuthenticatedUser } from '../src/common/auth';

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Administrator',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
  // Added with `principalType`; these fixtures are people, not integrations.
  principalType: 'USER',
};

const AREA = '20000000-0000-4000-8000-000000000001';

/** Captures what the service would have written, so the derivation is visible. */
function makeService() {
  const created: Array<{ label: string; keywords: string[] }> = [];
  const prisma = {
    propertyArea: { findFirst: async () => ({ id: AREA }) },
    areaChecklistItem: {
      findFirst: async () => null,
      aggregate: async () => ({ _max: { sortOrder: null } }),
      create: async ({ data }: { data: { label: string; keywords: string[] } }) => {
        created.push({ label: data.label, keywords: data.keywords });
        return { id: 'item-1', label: data.label, keywords: data.keywords, sortOrder: 0 };
      },
    },
    auditLog: { create: async () => ({}) },
  };
  const service = new FloorPlanAdminService(
    prisma as never,
    {} as never,
    {} as never,
    // Returns nothing per area, so the service falls back to the shared
    // templates and these assertions stay deterministic and offline.
    {
      generate: async (list: unknown[]) => ({ items: list.map(() => []), fellBack: true }),
    } as never,
    {} as never,
  );
  return { service, created };
}

describe('area checklist keywords', () => {
  it('derives what to listen for from the label when none are authored', async () => {
    const { service, created } = makeService();
    await service.createChecklistItem(user, AREA, { label: 'Sink, taps and drainage' });
    // "and" carries no meaning spoken aloud, and the plural is reduced because
    // the matcher accepts either form — "tap" covers "tap" and "taps", while
    // "taps" would cover only the plural.
    expect(created[0]).toEqual({
      label: 'Sink, taps and drainage',
      keywords: ['sink', 'tap', 'drainage'],
    });
  });

  it('leaves words that merely end in -s alone', async () => {
    const { service, created } = makeService();
    await service.createChecklistItem(user, AREA, { label: 'Glass and window status' });
    expect(created[0]?.keywords).toEqual(['glass', 'window', 'status']);
  });

  it('prefers authored keywords over the label', async () => {
    const { service, created } = makeService();
    await service.createChecklistItem(user, AREA, {
      label: 'Sink, taps and drainage',
      keywords: ['Faucet', 'faucet', ' TAP '],
    });
    // A synonym the label does not contain is the reason to author them at all,
    // so an explicit list replaces the derivation rather than adding to it.
    expect(created[0]?.keywords).toEqual(['faucet', 'tap']);
  });

  it('falls back to the label when the authored list is empty', async () => {
    const { service, created } = makeService();
    await service.createChecklistItem(user, AREA, { label: 'Walls and paintwork', keywords: [] });
    expect(created[0]?.keywords).toEqual(['wall', 'paintwork']);
  });
});
