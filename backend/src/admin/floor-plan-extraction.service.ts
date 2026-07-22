import { Injectable, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import { floorPlanExtractionSchema, type ExtractedArea } from '@texasrenters/shared';
import { z } from 'zod';

import { ApplicationError } from '../common/errors';
import type { AiTokenUsage, ResolvedAiConfiguration } from './ai-provider-settings.service';

const anthropicResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z
    .object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() })
    .optional(),
});
const openAiResponseSchema = z.object({
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});
const anthropicErrorSchema = z.object({
  error: z.object({ type: z.string(), message: z.string() }),
});
const openAiErrorSchema = z.object({
  error: z.object({ message: z.string().optional() }),
});

export interface FloorPlanExtractionResult {
  areas: ExtractedArea[];
  usage: AiTokenUsage;
}

@Injectable()
export class FloorPlanExtractionService {
  private readonly logger = new Logger(FloorPlanExtractionService.name);

  descriptor(configuration?: ResolvedAiConfiguration) {
    const resolved = configuration ?? this.legacyConfiguration();
    return {
      provider: resolved.provider.toLowerCase(),
      modelId: resolved.modelId,
      schemaVersion: '1',
    };
  }

  async extract(
    bytes: Buffer,
    mimeType: string,
    configuration?: ResolvedAiConfiguration,
  ): Promise<FloorPlanExtractionResult> {
    const resolved = configuration ?? this.legacyConfiguration();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response =
        resolved.provider === AiProvider.ANTHROPIC
          ? await this.anthropicRequest(bytes, mimeType, resolved, controller.signal)
          : await this.openAiRequest(bytes, mimeType, resolved, controller.signal);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw this.providerError(response.status, payload, resolved.provider);
      const providerResult =
        resolved.provider === AiProvider.ANTHROPIC
          ? this.parseAnthropic(payload)
          : this.parseOpenAi(payload);
      if (!providerResult.text.trim())
        throw new ApplicationError(
          422,
          'FLOOR_PLAN_EXTRACTION_EMPTY',
          'The AI model returned no text for this plan — its output limit was likely consumed. Retry, or select a more capable model in Settings.',
        );
      const areas = floorPlanExtractionSchema.safeParse(JSON.parse(this.cleanJson(providerResult.text)));
      if (!areas.success)
        throw new ApplicationError(
          422,
          'INVALID_FLOOR_PLAN_EXTRACTION',
          'The extracted floor-plan areas did not pass validation.',
        );
      return { areas: areas.data, usage: providerResult.usage };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      // The client gets a safe generic message; operators get the real cause.
      this.logger.error(
        `Floor-plan extraction failed (${resolved.provider}/${resolved.modelId})`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ApplicationError(
        502,
        'FLOOR_PLAN_EXTRACTION_FAILED',
        'The floor plan could not be analyzed safely.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private anthropicRequest(
    bytes: Buffer,
    mimeType: string,
    configuration: ResolvedAiConfiguration,
    signal: AbortSignal,
  ) {
    const source = { type: 'base64', media_type: mimeType, data: bytes.toString('base64') };
    const document =
      mimeType === 'application/pdf' ? { type: 'document', source } : { type: 'image', source };
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': configuration.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: configuration.modelId,
        max_tokens: 2_500,
        // No sampling parameters: Claude Sonnet 5 and Opus 4.8 reject
        // non-default temperature/top_p/top_k with a 400. Thinking is
        // disabled so the whole output budget goes to the JSON answer.
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: [document, { type: 'text', text: this.prompt() }] }],
      }),
    });
  }

  private openAiRequest(
    bytes: Buffer,
    mimeType: string,
    configuration: ResolvedAiConfiguration,
    signal: AbortSignal,
  ) {
    const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
    const file =
      mimeType === 'application/pdf'
        ? { type: 'input_file', filename: 'floor-plan.pdf', file_data: dataUrl }
        : { type: 'input_image', image_url: dataUrl };
    return fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${configuration.apiKey}`,
      },
      body: JSON.stringify({
        model: configuration.modelId,
        // GPT-5.x are reasoning models: reasoning tokens draw from the same
        // output budget, so give generous headroom and keep reasoning short —
        // otherwise economical tiers burn the whole budget before answering.
        max_output_tokens: 8_000,
        reasoning: { effort: 'low' },
        input: [{ role: 'user', content: [file, { type: 'input_text', text: this.prompt() }] }],
      }),
    });
  }

  private parseAnthropic(payload: unknown) {
    const parsed = anthropicResponseSchema.parse(payload);
    const inputTokens = parsed.usage?.input_tokens ?? 0;
    const outputTokens = parsed.usage?.output_tokens ?? 0;
    return {
      text: parsed.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text || '')
        .join('\n'),
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    };
  }

  private parseOpenAi(payload: unknown) {
    const parsed = openAiResponseSchema.parse(payload);
    return {
      text: parsed.output
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text || '')
        .join('\n'),
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        totalTokens: parsed.usage?.total_tokens ?? 0,
      },
    };
  }

  private cleanJson(text: string) {
    const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    // Models occasionally wrap the array in prose; keep only the JSON array.
    const start = stripped.indexOf('[');
    const end = stripped.lastIndexOf(']');
    return start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
  }

  private prompt() {
    return [
      'Extract only clearly labeled inspectable areas from this residential floor plan.',
      'Return a JSON array only. Each item must contain floorName, name, inspectionOrder, and isRequired.',
      'Use labels visible in the plan. Do not invent rooms. Use Ground Floor only when no floor is stated.',
      'inspectionOrder must start at 1 and be sequential. Garages, patios, and balconies may be optional; interior rooms are required.',
    ].join(' ');
  }

  private legacyConfiguration(): ResolvedAiConfiguration {
    if (process.env.FLOOR_PLAN_EXTRACTION_PROVIDER !== 'anthropic')
      throw new ApplicationError(
        503,
        'FLOOR_PLAN_EXTRACTION_NOT_CONFIGURED',
        'AI extraction is not configured. Add the property areas manually or configure the floor-plan extraction provider.',
      );
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const modelId = process.env.ANTHROPIC_FLOOR_PLAN_MODEL;
    if (!apiKey || !modelId)
      throw new ApplicationError(
        503,
        'FLOOR_PLAN_EXTRACTION_NOT_CONFIGURED',
        'AI extraction credentials and model are not configured.',
      );
    return { provider: AiProvider.ANTHROPIC, modelId, apiKey };
  }

  private providerError(status: number, payload: unknown, provider: AiProvider) {
    const anthropic = anthropicErrorSchema.safeParse(payload);
    const openAi = openAiErrorSchema.safeParse(payload);
    const providerMessage =
      provider === AiProvider.ANTHROPIC
        ? anthropic.success
          ? anthropic.data.error.message
          : ''
        : openAi.success
          ? openAi.data.error.message || ''
          : '';
    if ((status === 400 || status === 402) && /credit|billing|balance|quota/i.test(providerMessage))
      return new ApplicationError(
        402,
        'FLOOR_PLAN_AI_CREDITS_REQUIRED',
        'The AI provider account has no remaining credits. Add credits with the provider, or switch the active provider in Settings.',
      );
    if (status === 401 || status === 403)
      return new ApplicationError(
        503,
        'FLOOR_PLAN_AI_AUTHENTICATION_FAILED',
        'AI extraction credentials were rejected. Verify the provider configuration in Settings.',
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
    // Provider diagnostics are logged for operators but never surfaced to the
    // client verbatim (they may leak upstream internals).
    this.logger.warn(`${provider} extraction rejected (HTTP ${status}): ${providerMessage || 'no message'}`);
    return new ApplicationError(
      422,
      'FLOOR_PLAN_AI_REQUEST_REJECTED',
      'The extraction provider rejected this floor-plan request. Verify the file and configured model.',
    );
  }
}
