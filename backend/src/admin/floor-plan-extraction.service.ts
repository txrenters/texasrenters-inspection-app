import { Injectable } from '@nestjs/common';
import { floorPlanExtractionSchema, type ExtractedArea } from '@texasrenters/shared';
import { z } from 'zod';

import { ApplicationError } from '../common/errors';

const anthropicResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
const anthropicErrorSchema = z.object({
  error: z.object({ type: z.string(), message: z.string() }),
});

@Injectable()
export class FloorPlanExtractionService {
  descriptor() {
    return {
      provider: 'anthropic',
      modelId: process.env.ANTHROPIC_FLOOR_PLAN_MODEL || 'not-configured',
      schemaVersion: '1',
    };
  }

  async extract(bytes: Buffer, mimeType: string): Promise<ExtractedArea[]> {
    if (process.env.FLOOR_PLAN_EXTRACTION_PROVIDER !== 'anthropic')
      throw new ApplicationError(
        503,
        'FLOOR_PLAN_EXTRACTION_NOT_CONFIGURED',
        'AI extraction is not configured. Add the property areas manually or configure the floor-plan extraction provider.',
      );
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_FLOOR_PLAN_MODEL;
    if (!apiKey || !model)
      throw new ApplicationError(
        503,
        'FLOOR_PLAN_EXTRACTION_NOT_CONFIGURED',
        'AI extraction credentials and model are not configured.',
      );

    const source = { type: 'base64', media_type: mimeType, data: bytes.toString('base64') };
    const document =
      mimeType === 'application/pdf' ? { type: 'document', source } : { type: 'image', source };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2_500,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                document,
                {
                  type: 'text',
                  text: [
                    'Extract only clearly labeled inspectable areas from this residential floor plan.',
                    'Return a JSON array only. Each item must contain floorName, name, inspectionOrder, and isRequired.',
                    'Use labels visible in the plan. Do not invent rooms. Use Ground Floor only when no floor is stated.',
                    'inspectionOrder must start at 1 and be sequential. Garages, patios, and balconies may be optional; interior rooms are required.',
                  ].join(' '),
                },
              ],
            },
          ],
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw this.providerError(response.status, payload);
      const parsedResponse = anthropicResponseSchema.parse(payload);
      const text = parsedResponse.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text || '')
        .join('\n')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
      const areas = floorPlanExtractionSchema.safeParse(JSON.parse(text));
      if (!areas.success)
        throw new ApplicationError(
          422,
          'INVALID_FLOOR_PLAN_EXTRACTION',
          'The extracted floor-plan areas did not pass validation.',
        );
      return areas.data;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        502,
        'FLOOR_PLAN_EXTRACTION_FAILED',
        'The floor plan could not be analyzed safely.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private providerError(status: number, payload: unknown) {
    const parsed = anthropicErrorSchema.safeParse(payload);
    const providerMessage = parsed.success ? parsed.data.error.message : '';
    if (status === 400 && /credit|billing|balance/i.test(providerMessage))
      return new ApplicationError(
        402,
        'FLOOR_PLAN_AI_CREDITS_REQUIRED',
        'AI extraction credits are unavailable. Add provider credits or enter the property areas manually.',
      );
    if (status === 401 || status === 403)
      return new ApplicationError(
        503,
        'FLOOR_PLAN_AI_AUTHENTICATION_FAILED',
        'AI extraction credentials were rejected. Verify the backend provider configuration.',
      );
    if (status === 429)
      return new ApplicationError(
        429,
        'FLOOR_PLAN_AI_RATE_LIMITED',
        'AI extraction is temporarily rate limited. Wait briefly and retry.',
      );
    if (status >= 500)
      return new ApplicationError(
        502,
        'FLOOR_PLAN_AI_UNAVAILABLE',
        'The floor-plan extraction provider is temporarily unavailable.',
      );
    return new ApplicationError(
      422,
      'FLOOR_PLAN_AI_REQUEST_REJECTED',
      'The extraction provider rejected this floor-plan request. Verify the file and configured model.',
    );
  }
}
