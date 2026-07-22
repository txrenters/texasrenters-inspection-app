import { FloorPlanExtractionService } from '../src/admin/floor-plan-extraction.service';
import { AiProvider } from '@prisma/client';

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
        'The AI provider account has no remaining credits. Add credits with the provider, or switch the active provider in Settings.',
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

  it('extracts validated areas with OpenAI and returns recorded token usage', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      providerResponse(200, {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify([
                  {
                    floorName: 'Ground Floor',
                    name: 'Living Room',
                    inspectionOrder: 1,
                    isRequired: true,
                  },
                ]),
              },
            ],
          },
        ],
        usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
      }),
    ) as typeof fetch;

    await expect(
      new FloorPlanExtractionService().extract(jpegBytes(), 'image/jpeg', {
        provider: AiProvider.OPENAI,
        modelId: 'gpt-5.6-sol',
        apiKey: 'private-openai-key',
      }),
    ).resolves.toEqual({
      areas: [
        {
          floorName: 'Ground Floor',
          name: 'Living Room',
          inspectionOrder: 1,
          isRequired: true,
        },
      ],
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer private-openai-key' }),
      }),
    );
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
