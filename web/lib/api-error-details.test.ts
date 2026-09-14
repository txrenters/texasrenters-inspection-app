import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from './api';

/**
 * A refusal keeps what the API attached to it.
 *
 * Some refusals carry their own way out. "This report has already been
 * imported" names the inspection holding the report, and dropping that left the
 * office of 10118 Mariposa Green Ct with a message and nowhere to go.
 */

vi.mock('./session', () => ({
  getSession: () => Promise.resolve({ accessToken: 'token' }),
  signOut: vi.fn(),
}));

const respond = (status: number, body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: false,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response);

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.test';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an API refusal', () => {
  it('carries its details', async () => {
    respond(409, {
      statusCode: 409,
      code: 'REPORT_ALREADY_IMPORTED',
      message: 'This report has already been imported.',
      details: [{ inspectionId: 'inspection-9' }],
      requestId: 'request-1',
    });

    const error = await api('/api/v1/admin/inspections/x/inspection-imports').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'REPORT_ALREADY_IMPORTED',
      details: [{ inspectionId: 'inspection-9' }],
    });
  });

  it('has none rather than something malformed', async () => {
    respond(500, { code: 'INTERNAL', message: 'Broken', details: 'not a list' });

    const error = await api('/api/v1/anything').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ details: [] });
  });
});
