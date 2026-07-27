import { Injectable, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import { floorPlanExtractionSchema, type ExtractedArea } from '@texasrenters/shared';
import { z } from 'zod';

import { ApplicationError } from '../common/errors';
import type { AiTokenUsage, ResolvedAiConfiguration } from './ai-provider-settings.service';

const anthropicResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
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

type JsonObject = Record<string, unknown>;

@Injectable()
export class FloorPlanExtractionService {
  private readonly logger = new Logger(FloorPlanExtractionService.name);

  descriptor(configuration?: ResolvedAiConfiguration) {
    const resolved = configuration ?? this.legacyConfiguration();
    return {
      provider: resolved.provider.toLowerCase(),
      modelId: resolved.modelId,
      // v2 adds normalized marker/bounding-box coordinates. Legacy jobs stay v1
      // (no markers) and their areas remain valid + support manual placement.
      schemaVersion: '2',
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
      const areas = floorPlanExtractionSchema.safeParse(
        normalizeExtractionCandidates(this.extractionCandidates(providerResult.text)),
      );
      if (!areas.success) {
        this.logger.warn({
          event: 'floor_plan_extraction_validation_failed',
          provider: resolved.provider,
          modelId: resolved.modelId,
          issues: areas.error.issues.slice(0, 10).map((issue) => ({
            code: issue.code,
            path: issue.path.join('.'),
          })),
        });
        throw new ApplicationError(
          422,
          'INVALID_FLOOR_PLAN_EXTRACTION',
          'The AI returned incomplete floor-plan area data. Retry with a capable vision model, or add the missing areas manually.',
        );
      }
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
        : {
            type: 'input_image',
            image_url: dataUrl,
            // Floor plans contain small labels and fixture symbols. Explicit
            // high-detail vision avoids the low-resolution "auto" path that
            // can omit compact bathrooms, closets, and secondary rooms.
            detail: 'high',
          };
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
    const stripped = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const arrayStart = stripped.indexOf('[');
    const arrayEnd = stripped.lastIndexOf(']');
    const objectStart = stripped.indexOf('{');
    const objectEnd = stripped.lastIndexOf('}');
    if (arrayStart >= 0 && arrayEnd > arrayStart && (objectStart < 0 || arrayStart < objectStart))
      return stripped.slice(arrayStart, arrayEnd + 1);
    if (objectStart >= 0 && objectEnd > objectStart)
      return stripped.slice(objectStart, objectEnd + 1);
    return stripped;
  }

  private extractionCandidates(text: string) {
    let payload: unknown;
    try {
      payload = JSON.parse(this.cleanJson(text));
    } catch {
      throw new ApplicationError(
        422,
        'INVALID_FLOOR_PLAN_EXTRACTION',
        'The AI returned unreadable floor-plan area data. Retry with a capable vision model.',
      );
    }
    if (Array.isArray(payload)) return payload;
    const root = asObject(payload);
    if (!root) return [payload];
    const direct = firstArray(root, ['areas', 'rooms']);
    if (direct) return direct;
    const floors = firstArray(root, ['floors', 'levels', 'stories', 'storeys']);
    if (!floors) return [payload];
    return floors.flatMap((floor) => {
      const floorObject = asObject(floor);
      if (!floorObject) return [floor];
      const floorName =
        firstText(floorObject, ['floorName', 'floor_name', 'name', 'level', 'story', 'storey']) ??
        'Ground Floor';
      const areas = firstArray(floorObject, ['areas', 'rooms', 'spaces']);
      if (!areas) return [floor];
      return areas.map((area) => {
        const areaObject = asObject(area);
        if (!areaObject) return area;
        return {
          ...areaObject,
          floorName:
            firstText(areaObject, ['floorName', 'floor_name', 'floor', 'level']) ?? floorName,
        };
      });
    });
  }

  private prompt() {
    return [
      'Create a comprehensive inspection-area checklist from this residential floor plan.',
      'Inspect the complete image or every PDF page, including every story, before answering.',
      'Work exhaustively in two internal passes: first capture every visible room or exterior-area label, then scan every enclosed space again for omissions.',
      'Include clearly labeled areas and confidently identifiable unlabeled inspectable rooms when standard architectural fixtures make the room type unambiguous (for example, a bathroom containing a toilet, sink, tub, or shower).',
      'Give confidently identified unlabeled rooms a concise reviewable name such as "Bathroom (unlabeled)". Never infer a room from shape alone.',
      'Preserve visible floor labels such as First Floor and Second Floor.',
      'Return one flat JSON array only. Every item must contain floorName (string), name (string), inspectionOrder (integer), and isRequired (boolean).',
      'Also include a marker object {"x":number,"y":number} giving the approximate centre of the room as fractions of the FULL source image: x is the fraction from the left edge (0 = left, 1 = right) and y is the fraction from the top edge (0 = top, 1 = bottom); both between 0 and 1. Optionally include boundingBox {"x","y","width","height"} as the same normalized fractions of the whole image.',
      'Coordinates are relative to the original image or the specific PDF page only. Never draw on or return an annotated image, and never return pixel coordinates. Omit the marker for any room you cannot place confidently.',
      'Keep separate spaces separate even when they share a label; disambiguate them with a visible number or a stable positional suffix such as "(left)" and "(right)".',
      'Do not return dimensions, wall labels, fireplaces, loose fixtures, open-to-below voids, or duplicate rooms. Marker and boundingBox coordinates are the only spatial data to include.',
      'Include hallways, landings, stairs, closets, utility/laundry rooms, garages, patios, porches, decks, and balconies when they are labeled or visually unambiguous enclosed inspection spaces.',
      'Use Ground Floor only when no floor or story is stated.',
      'inspectionOrder must start at 1 and remain sequential across all floors. Garages, patios, porches, decks, and balconies may be optional; interior rooms are required.',
      'Before returning JSON, verify that every visible text label and every unmistakable bathroom or utility space is represented exactly once.',
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
    this.logger.warn(
      `${provider} extraction rejected (HTTP ${status}): ${providerMessage || 'no message'}`,
    );
    return new ApplicationError(
      422,
      'FLOOR_PLAN_AI_REQUEST_REJECTED',
      'The extraction provider rejected this floor-plan request. Verify the file and configured model.',
    );
  }
}

function normalizeExtractionCandidates(candidates: unknown[]) {
  const normalized: unknown[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates.slice(0, 101)) {
    const area = asObject(candidate);
    if (!area) {
      normalized.push(candidate);
      continue;
    }
    const floorName =
      firstText(area, ['floorName', 'floor_name', 'floor', 'level', 'story', 'storey']) ??
      'Ground Floor';
    const name = firstText(area, ['name', 'roomName', 'room_name', 'areaName', 'area_name']) ?? '';
    const key = `${floorName.toLocaleLowerCase()}:${name.toLocaleLowerCase()}`;
    if (name && seen.has(key)) continue;
    if (name) seen.add(key);
    const marker = readMarker(area);
    const boundingBox = readBoundingBox(area);
    normalized.push({
      floorName,
      name,
      inspectionOrder: normalized.length + 1,
      isRequired:
        firstBoolean(area, ['isRequired', 'is_required', 'required']) ?? requiredByDefault(name),
      ...(marker ? { marker } : {}),
      ...(boundingBox ? { boundingBox } : {}),
    });
  }
  return normalized;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads an approximate room-centre marker from a candidate. Only real numbers are
 * accepted (never coerced) so a null/string coordinate is dropped rather than
 * silently becoming 0. Out-of-range values are rejected later by the Zod schema.
 */
function readMarker(area: JsonObject) {
  const source =
    asObject(area.marker) ?? asObject(area.centroid) ?? asObject(area.center) ?? asObject(area.point);
  if (!source) return undefined;
  const x = readNumber(source.x);
  const y = readNumber(source.y);
  if (x === undefined || y === undefined) return undefined;
  const confidence = readNumber(source.confidence);
  return confidence === undefined ? { x, y } : { x, y, confidence };
}

function readBoundingBox(area: JsonObject) {
  const source = asObject(area.boundingBox) ?? asObject(area.bbox) ?? asObject(area.bounding_box);
  if (!source) return undefined;
  const x = readNumber(source.x);
  const y = readNumber(source.y);
  const width = readNumber(source.width ?? source.w);
  const height = readNumber(source.height ?? source.h);
  if (x === undefined || y === undefined || width === undefined || height === undefined)
    return undefined;
  return { x, y, width, height };
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function firstArray(value: JsonObject, keys: string[]) {
  for (const key of keys) if (Array.isArray(value[key])) return value[key] as unknown[];
  return undefined;
}

function firstText(value: JsonObject, keys: string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim())
      return candidate.trim().replace(/\s+/g, ' ');
    const nested = asObject(candidate);
    if (typeof nested?.name === 'string' && nested.name.trim())
      return nested.name.trim().replace(/\s+/g, ' ');
  }
  return undefined;
}

function firstBoolean(value: JsonObject, keys: string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'boolean') return candidate;
    if (
      candidate === 1 ||
      (typeof candidate === 'string' && /^(true|yes|required|1)$/i.test(candidate))
    )
      return true;
    if (
      candidate === 0 ||
      (typeof candidate === 'string' && /^(false|no|optional|0)$/i.test(candidate))
    )
      return false;
  }
  return undefined;
}

function requiredByDefault(name: string) {
  return !/\b(garage|patio|porch|deck|balcon(?:y|ies)|terrace|yard|carport)\b/i.test(name);
}
