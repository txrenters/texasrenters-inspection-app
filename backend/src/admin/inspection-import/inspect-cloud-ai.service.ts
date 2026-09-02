/**
 * Reading a report whose layout we do not recognise.
 *
 * The deterministic parser reads the Inspect & Cloud template exactly — 376
 * photographs out of 376 on the report it was built against — and nothing here
 * runs when it succeeds. Paying a model to re-read a table we can already
 * measure would be slower, cost per page, and answer differently on a rerun,
 * for evidence that ends up justifying a charge against a tenant.
 *
 * What it cannot do is read a layout nobody has written a parser for, and that
 * is the whole gap: a report from another system, or the same system after it
 * changes its template, is refused outright today. A model is the right tool
 * for an unknown shape in a way it is not for a known one.
 *
 * The polarity is the opposite of `AreaChecklistAiService`, deliberately. There
 * the model leads and the tables catch it, because reading a floor plan needs
 * one. Here the parser leads and the model catches it, because the document is
 * machine-readable. Both are the same rule: use the tool that fits the input.
 *
 * Everything it returns is validated before it is believed, and nothing it
 * says is committed without a person seeing it first — the preview is that
 * gate, and an import is never written straight from a model's answer.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import { z } from 'zod';

import { AiProviderSettingsService } from '../ai-provider-settings.service';
import type { ImportedReport } from './inspect-cloud-report';
import { matchChecklistLabel } from './inspect-cloud-report';

/** Long enough for a large report, short enough to fail before the job looks hung. */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * How much of the report the model is shown.
 *
 * Only the pages carrying a table. A report is mostly photographs — 40 of the
 * 48 pages on the one this was built against — and their pages hold nothing but
 * captions and capture times. Sending them would multiply the cost by six and
 * add nothing, so the pages are filtered by what is on them before any of it
 * leaves the building.
 */
const MAX_PAGES = 60;

const extractedSchema = z.object({
  areas: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        items: z
          .array(
            z.object({
              label: z.string().min(1).max(120),
              // Tri-state on purpose: a model that cannot tell whether a row
              // was graded must say so rather than pick one. `null` reaches the
              // database as "not assessed", which is what a blank row means.
              isClean: z.boolean().nullable(),
              isUndamaged: z.boolean().nullable(),
              isWorking: z.boolean().nullable(),
              comment: z.string().max(2000).nullable(),
            }),
          )
          .max(60),
      }),
    )
    .min(1)
    .max(60),
});

export interface AiReadResult {
  report: ImportedReport | null;
  provider: string | null;
  modelId: string | null;
  reason: 'NO_CREDENTIAL' | 'REFUSED' | 'INVALID_OUTPUT' | 'OK';
}

@Injectable()
export class InspectCloudAiService {
  private readonly logger = new Logger(InspectCloudAiService.name);

  constructor(
    @Inject(AiProviderSettingsService) private readonly aiSettings: AiProviderSettingsService,
  ) {}

  /**
   * Read the report's text with a model, when the parser could not.
   *
   * Returns null rather than throwing on every failure path. An unreadable
   * report is an answer the console can show — "we could not read this, here
   * is why" — and a thrown error from a provider outage reads to an
   * administrator as though their file were at fault.
   */
  async read(
    organizationId: string,
    pages: Array<{ number: number; text: string }>,
  ): Promise<AiReadResult> {
    const configuration = await this.aiSettings.resolve(organizationId);
    if (!configuration?.apiKey)
      return { report: null, provider: null, modelId: null, reason: 'NO_CREDENTIAL' };

    const tablePages = pages.filter((page) => looksLikeTable(page.text)).slice(0, MAX_PAGES);
    if (!tablePages.length)
      return {
        report: null,
        provider: configuration.provider,
        modelId: configuration.modelId,
        reason: 'REFUSED',
      };

    let raw: string | null;
    try {
      raw = await this.ask(configuration, tablePages);
    } catch (error) {
      this.logger.warn({
        event: 'inspection_import_ai_failed',
        provider: configuration.provider,
        message: error instanceof Error ? error.message : 'unknown',
      });
      return {
        report: null,
        provider: configuration.provider,
        modelId: configuration.modelId,
        reason: 'REFUSED',
      };
    }

    const parsed = extractedSchema.safeParse(readJson(raw));
    if (!parsed.success) {
      this.logger.warn({ event: 'inspection_import_ai_invalid_output' });
      return {
        report: null,
        provider: configuration.provider,
        modelId: configuration.modelId,
        reason: 'INVALID_OUTPUT',
      };
    }

    return {
      report: toReport(parsed.data),
      provider: configuration.provider,
      modelId: configuration.modelId,
      reason: 'OK',
    };
  }

  private async ask(
    configuration: { provider: AiProvider; modelId: string; apiKey: string },
    pages: Array<{ number: number; text: string }>,
  ) {
    const prompt = [
      'You are reading a residential property inspection report that has been',
      'converted to text. Return JSON only, matching this shape exactly:',
      '{"areas":[{"name":"KITCHEN","items":[{"label":"DOORS & LOCKS",',
      '"isClean":true,"isUndamaged":true,"isWorking":false,',
      '"comment":"Handle loose"}]}]}',
      '',
      'Rules:',
      '- One entry per room or area heading in the report.',
      '- One item per row of that area’s condition table.',
      '- The three booleans are the clean / undamaged / working columns.',
      '- Use null for any column the report left blank. Never guess a grade:',
      '  a blank means the inspector did not assess it, and recording false',
      '  would invent damage that was never observed.',
      '- comment is the row’s own comment text, or null.',
      '- Copy labels as the report writes them. Do not translate or tidy them.',
      '- Return no prose, no explanation, and no markdown fence.',
      '',
      'Report text follows, one page per block:',
      ...pages.map((page) => `--- page ${page.number} ---\n${page.text}`),
    ].join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response =
        configuration.provider === AiProvider.ANTHROPIC
          ? await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              signal: controller.signal,
              headers: {
                'content-type': 'application/json',
                'x-api-key': configuration.apiKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: configuration.modelId,
                max_tokens: 8192,
                messages: [{ role: 'user', content: prompt }],
              }),
            })
          : await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              signal: controller.signal,
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${configuration.apiKey}`,
              },
              body: JSON.stringify({
                model: configuration.modelId,
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: 'json_object' },
              }),
            });

      if (!response.ok) throw new Error(`provider returned ${response.status}`);
      const body: unknown = await response.json();
      return textFrom(body);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A page worth sending: one carrying a condition table rather than photographs. */
function looksLikeTable(text: string) {
  return /ROOM\s*\/\s*ITEM/i.test(text) || /\bY\b[\s\S]{0,40}\bN\b/.test(text);
}

const anthropicShape = z.object({
  content: z.array(z.object({ text: z.string().optional() })),
});
const openAiShape = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })),
});

function textFrom(body: unknown): string | null {
  const anthropic = anthropicShape.safeParse(body);
  if (anthropic.success)
    return anthropic.data.content.map((part) => part.text ?? '').join('') || null;
  const openAi = openAiShape.safeParse(body);
  if (openAi.success) return openAi.data.choices[0]?.message.content ?? null;
  return null;
}

/** The JSON inside a reply, whether or not the model wrapped it in a fence. */
function readJson(raw: string | null): unknown {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // A model that added a sentence before the object is common enough to be
    // worth recovering from; one that returned prose is not, and falls through
    // to the schema check as null.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * The model's answer in the same shape the parser produces.
 *
 * Labels are matched against the template here rather than by the model, so an
 * AI-read report and a measured one resolve identically — asking the model to
 * pick our vocabulary would let it invent an item that no template carries.
 *
 * No photographs. The model reads text; the pictures are matched to items by
 * their captions, which is the parser's job and needs coordinates it does not
 * have. An AI-read report imports its condition and its comments, and its
 * photographs arrive attached to the area rather than to a specific item.
 */
function toReport(data: z.infer<typeof extractedSchema>): ImportedReport {
  return {
    inspector: null,
    template: null,
    reportDate: null,
    pages: 0,
    unrecognised: [],
    areas: data.areas.map((area) => ({
      name: area.name,
      startedOnPage: 0,
      photos: [],
      items: area.items.map((item) => {
        const match = matchChecklistLabel(item.label);
        return {
          sourceLabel: item.label,
          matchedLabel: match.label,
          matchScore: match.score,
          isClean: item.isClean,
          isUndamaged: item.isUndamaged,
          isWorking: item.isWorking,
          comment: item.comment,
          assessed:
            item.isClean !== null || item.isUndamaged !== null || item.isWorking !== null,
          page: 0,
        };
      }),
    })),
  };
}
