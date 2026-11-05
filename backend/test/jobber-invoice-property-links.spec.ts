import { buildAddressIndex, buildLooseAddressIndex } from '../src/integrations/jobber/jobber.address';
import { JobberMappingService } from '../src/integrations/jobber/jobber.mapping.service';

/**
 * Invoices find their property's page through the Jobber property they are for
 * (2026-11-05): the moment the matcher links that property, or somebody links
 * it by hand in the mapping queue, its invoices on no page yet move onto the
 * building -- and only those, never one already matched through its visit.
 * Ids and addresses invented.
 */

const ORG = '30000000-0000-4000-8000-000000000001';
const office = { id: 'user-1', organizationId: ORG } as never;

describe('when the matcher links a Jobber property', () => {
  const buildings = [{ id: 'building-1', addressLine1: '100 Example Way', postalCode: '77000' }];
  const index = { strict: buildAddressIndex(buildings), loose: buildLooseAddressIndex(buildings) };
  const property = { jobberPropertyId: 'p-1', addressLine1: '100 Example Way', postalCode: '77000' };

  function database(existing: unknown = null) {
    return {
      jobberPropertyLink: {
        findUnique: jest.fn().mockResolvedValue(existing),
        upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => ({ id: 'link-1', ...create })),
      },
      propertywareUnit: { count: jest.fn().mockResolvedValue(0) },
      invoice: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    };
  }

  it("puts that property's invoices on no page yet onto the building", async () => {
    const db = database();
    const link = await new JobberMappingService(db as never).resolveProperty(ORG, property, index);

    expect(link).toMatchObject({ status: 'LINKED', propertywareBuildingId: 'building-1' });
    expect(db.invoice.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, jobberPropertyId: 'p-1', propertywareBuildingId: null },
      data: { propertywareBuildingId: 'building-1' },
    });
  });

  it('moves nothing for a property it cannot link', async () => {
    const db = database();
    await new JobberMappingService(db as never).resolveProperty(ORG, { jobberPropertyId: 'p-2', addressLine1: '9 Nowhere Rd', postalCode: '77999' }, index);
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing again for a property already linked: a decided link is never re-decided', async () => {
    const db = database({ id: 'link-1', status: 'LINKED', propertywareBuildingId: 'building-1' });
    await new JobberMappingService(db as never).resolveProperty(ORG, property, index);
    expect(db.jobberPropertyLink.upsert).not.toHaveBeenCalled();
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
  });
});

describe('when somebody links a Jobber property by hand', () => {
  it('moves its invoices on no page yet onto the building, and says how many in the audit entry', async () => {
    const tx = {
      jobberPropertyLink: {
        findFirst: jest.fn().mockResolvedValue({ id: 'link-1', jobberPropertyId: 'p-1' }),
        update: jest.fn().mockResolvedValue({ id: 'link-1', status: 'LINKED', jobberPropertyId: 'p-1' }),
      },
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue({ id: 'building-1' }) },
      propertywareUnit: { count: jest.fn().mockResolvedValue(0) },
      jobberVisitImport: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      invoice: { updateMany: jest.fn().mockResolvedValue({ count: 4 }) },
      auditLog: { create: jest.fn() },
    };
    const db = { $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)) };

    await new JobberMappingService(db as never).link(office, 'link-1', { buildingId: 'building-1' });

    expect(tx.invoice.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, jobberPropertyId: 'p-1', propertywareBuildingId: null },
      data: { propertywareBuildingId: 'building-1' },
    });
    expect(tx.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ releasedVisits: 1, linkedInvoices: 4 });
  });
});
