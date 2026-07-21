import { FloorPlanExtractionService } from '../src/admin/floor-plan-extraction.service';

describe('floor-plan extraction provider errors', () => {
  const originalFetch = global.fetch;
  const originalEnvironment = {
    provider: process.env.FLOOR_PLAN_EXTRACTION_PROVIDER,
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_FLOOR_PLAN_MODEL,
  };

  beforeEach(() => {
    process.env.FLOOR_PLAN_EXTRACTION_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_FLOOR_PLAN_MODEL = 'test-model';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restore('FLOOR_PLAN_EXTRACTION_PROVIDER', originalEnvironment.provider);
    restore('ANTHROPIC_API_KEY', originalEnvironment.apiKey);
    restore('ANTHROPIC_FLOOR_PLAN_MODEL', originalEnvironment.model);
    jest.restoreAllMocks();
  });

  it('maps insufficient provider credits to an actionable payment-required error', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      providerResponse(400, {
        error: {
          type: 'invalid_request_error',
          message: 'Your credit balance is too low to access the API.',
        },
      }),
    ) as typeof fetch;

    await expect(
      new FloorPlanExtractionService().extract(jpegBytes(), 'image/jpeg'),
    ).rejects.toMatchObject({
      status: 402,
      code: 'FLOOR_PLAN_AI_CREDITS_REQUIRED',
      message:
        'AI extraction credits are unavailable. Add provider credits or enter the property areas manually.',
    });
  });

  it('does not expose arbitrary provider error messages', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      providerResponse(400, {
        error: { type: 'invalid_request_error', message: 'private upstream diagnostic' },
      }),
    ) as typeof fetch;

    await expect(
      new FloorPlanExtractionService().extract(jpegBytes(), 'image/jpeg'),
    ).rejects.toMatchObject({
      status: 422,
      code: 'FLOOR_PLAN_AI_REQUEST_REJECTED',
      message:
        'The extraction provider rejected this floor-plan request. Verify the file and configured model.',
    });
  });
});

function providerResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function jpegBytes() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
}

function restore(name: string, value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
