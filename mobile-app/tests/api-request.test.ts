const mockGetSession = jest.fn();

jest.mock('../src/config/environment', () => ({
  environment: {
    apiBaseUrl: 'https://mobile-tunnel.exp.direct/api/v1',
    apiBaseUrls: ['https://mobile-tunnel.exp.direct/api/v1', 'http://192.168.123.48:3000/api/v1'],
  },
}));
jest.mock('../src/auth/supabase', () => ({
  getSupabaseClient: () => ({ auth: { getSession: mockGetSession } }),
}));

import {
  ApiFloorPlanRepository,
  ApiFindingRepository,
  ApiInspectionRepository,
  requestJson,
} from '../src/repositories/api/repositories';

describe('mobile API fallback requests', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'test-access-token' } },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('falls back to the LAN API when the Expo tunnel proxy returns a gateway error', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response(502, { message: 'TexasRenters backend is unavailable.' }))
      .mockResolvedValueOnce(response(200, { id: 'technician-1' }));
    global.fetch = fetchMock as typeof fetch;

    await expect(requestJson('/api/v1/auth/me')).resolves.toEqual({ id: 'technician-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://mobile-tunnel.exp.direct/api/v1/auth/me',
      'http://192.168.123.48:3000/api/v1/auth/me',
    ]);
  });

  it('does not replay write requests through a fallback URL', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(response(502, { message: 'TexasRenters backend is unavailable.' }));
    global.fetch = fetchMock as typeof fetch;

    await expect(
      requestJson('/api/v1/auth/change-required-password', {
        method: 'POST',
        body: JSON.stringify({ password: 'replacement' }),
      }),
    ).rejects.toThrow('TexasRenters backend is unavailable.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends inspection filters to the paginated summary endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response(200, { items: [] }));
    global.fetch = fetchMock as typeof fetch;

    await expect(
      new ApiInspectionRepository().list({ status: 'SCHEDULED', search: '  Main St  ' }),
    ).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://mobile-tunnel.exp.direct/api/v1/technician/inspections?page=1&pageSize=25&status=SCHEDULED&search=Main+St',
    );
  });

  it('loads inspection overview data from one context endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      response(200, {
        inspection: inspection('inspection-1'),
        property: property('property-1'),
        rooms: [],
        pendingReviewCount: 0,
      }),
    );
    global.fetch = fetchMock as typeof fetch;

    await expect(new ApiInspectionRepository().context('inspection-1')).resolves.toMatchObject({
      pendingReviewCount: 0,
      rooms: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://mobile-tunnel.exp.direct/api/v1/technician/inspections/inspection-1/context',
    );
  });

  it('loads findings from the bounded paginated endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response(200, { items: [] }));
    global.fetch = fetchMock as typeof fetch;

    await expect(new ApiFindingRepository().list('inspection-1')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://mobile-tunnel.exp.direct/api/v1/technician/inspections/inspection-1/findings?page=1&pageSize=100',
    );
  });

  it('treats a missing approved floor plan as a valid empty result', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response(200, null));
    global.fetch = fetchMock as typeof fetch;

    await expect(new ApiFloorPlanRepository().get('property-1')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://mobile-tunnel.exp.direct/api/v1/technician/properties/property-1/floor-plan',
    );
  });
});

function property(id: string) {
  return {
    id,
    externalPropertyId: 'building-external',
    externalOwnerId: '',
    externalPortfolioId: 'portfolio-external',
    name: '1 Main St',
    address: '1 Main St',
    cityStateZip: 'Austin, TX 78701',
    bedrooms: 2,
    bathrooms: 1,
    floors: ['Ground Floor'],
    accessInstructions: '',
    notes: '',
    imageTone: 'teal',
  };
}

function inspection(id: string) {
  return {
    id,
    externalInspectionId: id,
    propertyId: 'property-1',
    type: 'MOVE_OUT',
    scheduledAt: '2026-07-21T10:00:00.000Z',
    assignedUserId: 'technician-1',
    status: 'SCHEDULED',
    priority: 'STANDARD',
    roomIds: [],
    propertyNotes: '',
    property: {
      id: 'property-1',
      address: '1 Main St',
      cityStateZip: 'Austin, TX 78701',
      imageTone: 'teal',
    },
    progress: { completed: 0, total: 0, hasFailedUpload: false },
  };
}

function response(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
  } as unknown as Response;
}
