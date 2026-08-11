import { Injectable, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import {
  areaChecklistGenerationSchema,
  checklistTemplateFor,
  CHECKLIST_VOCABULARY,
} from '@texasrenters/shared';
import { z } from 'zod';

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
    })
    .optional(),
});

export interface ChecklistArea {
  name: string;
  category?: string | null;
  environment?: 'INDOOR' | 'OUTDOOR' | 'SEMI_OUTDOOR' | null;
}

export interface AreaChecklistResult {
  /** One list per input area, in the same order. Never empty. */
  items: string[][];
  usage?: AiTokenUsage;
  /** True when every list came from the tables rather than the model. */
  fellBack: boolean;
}

/**
 * Chooses each area's checklist items.
 *
 * The tables in `@texasrenters/shared` encode the house standard but apply it by
 * room *kind*, which over-applies: every indoor area got doors, windows and
 * ceilings, so a staircase was asked about its doors and locks and a landing
 * about its windows. Deciding per area is a judgement about what is physically
 * there, which is what the model is for.
 *
 * Three things keep that judgement honest:
 *
 * - The standard wording is supplied as preferred vocabulary. Left free, a model
 *   writes "Light fixtures" here and "Lights and power points" there, and the
 *   two never line up across a report or match the same spoken words.
 * - The output is schema-validated, and anything malformed is discarded rather
 *   than written.
 * - **Every failure falls back to the tables.** A provider outage, an empty
 *   response, an area the model skipped — each yields the deterministic list for
 *   that area rather than nothing. A missing checklist is worse than a
 *   conservative one: it leaves a technician with nothing to cover.
 *
 * The result is a draft either way. Areas are reviewed before approval, and the
 * checklist is editable there.
 */
@Injectable()
export class AreaChecklistAiService {
  private readonly logger = new Logger(AreaChecklistAiService.name);

  /** The tables, for one area. Used as the fallback and when AI is disabled. */
  fallbackFor(area: ChecklistArea) {
    return checklistTemplateFor({
      name: area.name,
      category: area.category ?? null,
      environment: area.environment ?? null,
    });
  }

  async generate(
    areas: ChecklistArea[],
    configuration: ResolvedAiConfiguration | undefined,
  ): Promise<AreaChecklistResult> {
    const fallback = areas.map((area) => this.fallbackFor(area));
    if (!areas.length) return { items: [], fellBack: true };
    if (!configuration?.apiKey) return { items: fallback, fellBack: true };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response =
        configuration.provider === AiProvider.ANTHROPIC
          ? await this.anthropicRequest(areas, configuration, controller.signal)
          : await this.openAiRequest(areas, configuration, controller.signal);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`provider responded ${response.status}`);

      const parsed =
        configuration.provider === AiProvider.ANTHROPIC
          ? this.parseAnthropic(payload)
          : this.parseOpenAi(payload);
      const generated = areaChecklistGenerationSchema.safeParse(this.jsonFrom(parsed.text));
      if (!generated.success) throw new Error('output failed validation');

      const byIndex = new Map(generated.data.map((entry) => [entry.index, entry.items]));
      let used = 0;
      const items = areas.map((area, index) => {
        const proposed = this.clean(byIndex.get(index));
        // Per area, not all-or-nothing: one skipped area should not discard
        // good lists for the other twenty.
        if (!proposed.length) return fallback[index]!;
        used += 1;
        return proposed;
      });
      return { items, usage: parsed.usage, fellBack: used === 0 };
    } catch (error) {
      // Never fatal. Extraction has already produced the areas, and refusing to
      // write them because their checklists could not be generated would lose
      // the expensive half of the work over the cheap half.
      this.logger.warn(
        `Area checklist generation fell back to the templates (${configuration.provider}/${configuration.modelId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { items: fallback, fellBack: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Trim, drop blanks, and de-duplicate case-insensitively while keeping order. */
  private clean(items: string[] | undefined) {
    if (!items) return [];
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of items) {
      const label = raw.trim().replace(/\s+/g, ' ');
      const key = label.toLowerCase();
      if (!label || seen.has(key)) continue;
      seen.add(key);
      cleaned.push(label);
    }
    return cleaned;
  }

  private prompt(areas: ChecklistArea[]) {
    const listed = areas
      .map(
        (area, index) =>
          `${index}. ${area.name}${area.category ? ` (category ${area.category}` : ''}${
            area.category ? `, ${area.environment ?? 'INDOOR'})` : ` (${area.environment ?? 'INDOOR'})`
          }`,
      )
      .join('\n');

    return [
      'You are preparing the inspection checklist for each area of a residential rental property.',
      'For every area listed, return the items an inspector should physically check in THAT area.',
      '',
      'Rules:',
      '- Include an item only if it is normally present in that kind of area. A staircase has no doors, locks or windows unless its name says otherwise; a hallway has no cupboards; a bathroom has no bench tops or appliances.',
      '- Never pad a list to make areas look alike. A stairway with three items is a correct answer.',
      '- Prefer the exact wording below whenever an item matches one of them. Only invent wording for something genuinely absent from the list.',
      '- Outdoor areas are inspected from the outside: no ceilings, no interior fixtures.',
      '- Order each list the way an inspector would walk it: the structure first (floor, walls), then openings, then fixtures and appliances.',
      '- Between 3 and 15 items for a normal room. Never zero.',
      '',
      `Preferred wording:\n${CHECKLIST_VOCABULARY.map((label) => `- ${label}`).join('\n')}`,
      '',
      `Areas:\n${listed}`,
      '',
      'Return JSON only, no prose or code fences: an array of {"index": <the number above>, "items": ["...", "..."]}, one entry per area, using the same index numbers.',
    ].join('\n');
  }

  private anthropicRequest(
    areas: ChecklistArea[],
    configuration: ResolvedAiConfiguration,
    signal: AbortSignal,
  ) {
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
        max_tokens: 4_000,
        // Same constraint as floor-plan extraction: the current models reject
        // non-default sampling parameters, and thinking would eat the budget
        // the JSON answer needs.
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: [{ type: 'text', text: this.prompt(areas) }] }],
      }),
    });
  }

  private openAiRequest(
    areas: ChecklistArea[],
    configuration: ResolvedAiConfiguration,
    signal: AbortSignal,
  ) {
    return fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${configuration.apiKey}`,
      },
      body: JSON.stringify({
        model: configuration.modelId,
        max_output_tokens: 4_000,
        input: [{ role: 'user', content: [{ type: 'input_text', text: this.prompt(areas) }] }],
      }),
    });
  }

  private parseAnthropic(payload: unknown) {
    const parsed = anthropicResponseSchema.parse(payload);
    return {
      text: parsed.content.map((block) => block.text ?? '').join(''),
      usage: parsed.usage
        ? {
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
            totalTokens: parsed.usage.input_tokens + parsed.usage.output_tokens,
          }
        : undefined,
    };
  }

  private parseOpenAi(payload: unknown) {
    const parsed = openAiResponseSchema.parse(payload);
    return {
      text: parsed.output
        .flatMap((item) => item.content ?? [])
        .map((block) => block.text ?? '')
        .join(''),
      usage: parsed.usage
        ? {
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
            totalTokens: parsed.usage.input_tokens + parsed.usage.output_tokens,
          }
        : undefined,
    };
  }

  /** The JSON array in the reply, tolerating a code fence or surrounding prose. */
  private jsonFrom(text: string): unknown {
    const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
