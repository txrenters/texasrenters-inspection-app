import { detailsView, ownerView, privateDetails } from '../src/admin/property-details-view';
import { buildingDetails } from '../src/integrations/propertyware/propertyware.building-details';
import { PropertywareClient } from '../src/integrations/propertyware/propertyware.client';
import { mapBuilding } from '../src/integrations/propertyware/propertyware.mapper';
import { parseOwnerReport, PropertywareOwnerReportService } from '../src/integrations/propertyware/propertyware.owner-report';
import type { RawPropertywareBuilding } from '../src/integrations/propertyware/propertyware.schemas';

/**
 * A property as Propertyware describes it, on the console's Details tab (the
 * office, 2026-10-01). Every name, code, phone and address here is invented.
 */

const raw = {
  id: 101,
  portfolioID: 7,
  name: '1 Example St',
  active: true,
  status: 'Occupied',
  yearBuilt: 2004,
  numberFloors: 2,
  numberOfBedrooms: 3,
  numberOfBathrooms: 2.5,
  neighborhood: 'Example Park',
  county: 'Harris County',
  ready: false,
  rentable: true,
  targetRent: 1850,
  targetDeposit: 0,
  targetDepositAmount: 1850,
  maintenanceSpendingLimitAmount: 300,
  maintenanceSpendingLimitTime: 'Per Request',
  maintenanceNotice: '  Call before any repair over $300.  ',
  lastModifiedDateTime: '2026-09-30T21:25:43Z',
  lastModifiedBy: 'Office Person',
  amenities: [{ name: 'Fenced yard' }, { name: '  ' }, { code: 'X' }],
  marketing: {
    availableDate: '2026-10-15',
    petsAllowed: true,
    smokingAllowed: false,
    publishedForRent: false,
    parcelNumber: '0000000000001',
    shortDescription: 'A three-bedroom home.',
  },
  management: { managementContractStartDate: '2021-02-08T00:00:00Z', managementContractEndDate: null },
  propertyManagerList: [{ name: 'Pat Manager', email: 'pat@example.com', roleAsString: 'Property Manager' }, { email: 'x' }],
  customFields: [
    { fieldName: 'Occupancy Status', value: 'In Lease' },
    { fieldName: 'Lockbox Code', value: ' 1234 ' },
    { fieldName: 'Make Ready Notes', value: 'Not Completed' },
    { fieldName: 'Water Provider', value: '' },
    { fieldName: 'Pool Service', value: null },
  ],
} as unknown as RawPropertywareBuilding;

describe('a building, as the property page shows it', () => {
  it('reads the building record and every custom field with a value', () => {
    const details = buildingDetails(raw as unknown as Record<string, unknown>);

    expect(details.building).toEqual({
      yearBuilt: 2004,
      floors: 2,
      bedrooms: 3,
      bathrooms: 2.5,
      neighborhood: 'Example Park',
      county: 'Harris County',
      parcelNumber: '0000000000001',
      amenities: ['Fenced yard'],
    });
    expect(details.leasing).toMatchObject({
      status: 'Occupied',
      ready: false,
      availableDate: '2026-10-15',
      targetRent: 1850,
      targetDeposit: 1850,
      petsAllowed: true,
      smokingAllowed: false,
    });
    expect(details.management).toMatchObject({
      contractStart: '2021-02-08',
      contractEnd: null,
      maintenanceLimit: 300,
      maintenanceLimitPeriod: 'Per Request',
      maintenanceNotice: 'Call before any repair over $300.',
      managers: [{ name: 'Pat Manager', email: 'pat@example.com', role: 'Property Manager' }],
    });
    expect(details.updated).toEqual({ at: '2026-09-30T21:25:43Z', by: 'Office Person' });
    // Empty cells are left out; placeholders are kept, and hidden only when shown.
    expect(details.customFields).toEqual([
      { name: 'Occupancy Status', value: 'In Lease' },
      { name: 'Lockbox Code', value: '1234' },
      { name: 'Make Ready Notes', value: 'Not Completed' },
    ]);
  });

  it('blanks what Propertyware leaves at zero or sends in a shape it does not know', () => {
    const details = buildingDetails({ id: 1, yearBuilt: 0, targetRent: 'lots', numberFloors: null, marketing: 'odd' });

    expect(details.building.yearBuilt).toBeNull();
    expect(details.building.floors).toBeNull();
    expect(details.leasing.targetRent).toBeNull();
    expect(details.leasing.availableDate).toBeNull();
    expect(details.customFields).toEqual([]);
  });

  it('is carried on the building the sync maps', () => {
    expect(mapBuilding(raw).details?.leasing.status).toBe('Occupied');
  });

  it('asks Propertyware for the custom fields of buildings, and only of buildings', async () => {
    process.env.PROPERTYWARE_PROVIDER = 'live';
    process.env.PROPERTYWARE_CLIENT_ID = 'client';
    process.env.PROPERTYWARE_CLIENT_SECRET = 'secret';
    process.env.PROPERTYWARE_ORGANIZATION_ID = 'system';
    const fetchMock = jest.fn(() => Promise.resolve(new Response('[]', { status: 200 })));
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new PropertywareClient();

    await client.fetchPage('buildings', {}, 'c1');
    await client.fetchPage('units', {}, 'c2');

    const asked = (fetchMock.mock.calls as unknown as [URL][]).map(([url]) => url.searchParams.get('includeCustomFields'));
    expect(asked).toEqual(['true', 'false']);
  });
});

describe('what the page may show, and what it may not', () => {
  const stored = buildingDetails(raw as unknown as Record<string, unknown>);
  const owner = {
    owners: 'Sam Owner',
    portfolioName: 'Owner, Sam',
    mobilePhones: '(555) 010-0000',
    homePhones: null,
    managementAgreementSignedOn: '2021-02-08',
  };

  it('never sends the access codes or the owners’ phones with the page', () => {
    const view = detailsView(stored)!;
    expect(view.customFields.map((field) => field.name)).toEqual(['Occupancy Status', 'Make Ready Notes']);
    expect(view.accessFieldsOnFile).toBe(1);
    expect(JSON.stringify(view)).not.toContain('1234');

    expect(ownerView(owner)).toEqual({
      owners: 'Sam Owner',
      portfolioName: 'Owner, Sam',
      managementAgreementSignedOn: '2021-02-08',
      phonesOnFile: true,
    });
  });

  it('gives them on their own request', () => {
    expect(privateDetails(stored, owner)).toEqual({
      access: [{ name: 'Lockbox Code', label: 'Lockbox Code', value: '1234' }],
      ownerPhones: { mobile: '(555) 010-0000', home: null },
    });
  });

  it('reads a building the sync has not described yet as nothing, not as an error', () => {
    expect(detailsView(null)).toBeNull();
    expect(detailsView({ unexpected: true })).toBeNull();
    expect(ownerView(null)).toBeNull();
    expect(privateDetails(null, null)).toEqual({ access: [], ownerPhones: null });
  });
});

describe('the property-owner report', () => {
  const report = {
    columns: [
      { index: '0', label: 'Portfolio Name' },
      { index: '1', label: 'Property Owners' },
      { index: '2', label: 'Property Owner Mobile Phones' },
      { index: '3', label: 'Property Owner Home Phones' },
      { index: '4', label: 'Building Entity ID' },
      { index: '5', label: 'Date 1st Mgmt Agreement Signed' },
    ],
    records: [
      { '0': 'Owner, Sam', '1': 'Sam Owner', '2': '(555) 010-0000', '3': '', '4': '101', '5': '02/08/2021' },
      { '0': 'Nobody', '1': 'Nobody', '2': null, '3': null, '4': '', '5': '' },
    ],
  };

  it('reads each building’s owners by label, and drops a row with no building', () => {
    expect(parseOwnerReport(report)).toEqual([
      {
        buildingExternalId: '101',
        owners: 'Sam Owner',
        portfolioName: 'Owner, Sam',
        mobilePhones: '(555) 010-0000',
        homePhones: null,
        managementAgreementSignedOn: '2021-02-08',
      },
    ]);
  });

  it('refuses a report without the building column, naming it', () => {
    expect(() => parseOwnerReport({ columns: [{ index: '0', label: 'Property Owners' }], records: [] })).toThrow(
      /Building Entity ID/,
    );
  });

  it('writes only the buildings whose owners changed, and counts the ones it cannot find', async () => {
    const rows = parseOwnerReport(report);
    const unchanged = { ...rows[0]!, buildingExternalId: '102' };
    // What is stored on a building: the row without its building id.
    const firstOwner = {
      owners: 'Sam Owner',
      portfolioName: 'Owner, Sam',
      mobilePhones: '(555) 010-0000',
      homePhones: null,
      managementAgreementSignedOn: '2021-02-08',
    };
    const prisma = {
      propertywareBuilding: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'b1', externalId: '101', ownerDetails: null },
          { id: 'b2', externalId: '102', ownerDetails: { ...firstOwner } },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new PropertywareOwnerReportService(prisma as never);

    const result = await service.apply('org-1', [...rows, unchanged, { ...rows[0]!, buildingExternalId: '999' }]);

    expect(result).toEqual({ fetched: 3, updated: 1, unmatched: 1 });
    expect(prisma.propertywareBuilding.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { ownerDetails: firstOwner } });
  });
});
