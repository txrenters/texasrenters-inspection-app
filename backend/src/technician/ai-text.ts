import { AiProvider } from '@prisma/client';
import { z } from 'zod';

import type { AiTokenUsage, ResolvedAiConfiguration } from '../admin/ai-provider-settings.service';
import { ApplicationError } from '../common/errors';

/**
 * One text prompt to the organization's AI provider, one text answer.
 *
 * Shared by the narration's checklist pre-fill and its summary for the report,
 * which ask the same kind of question of the same transcripts. The provider
 * is the organization's active one (`AiProviderSettingsService.resolve`); the
 * key never leaves this call.
 */

const anthropicSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z
    .object({ input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative() })
    .optional(),
});

const openAiSchema = z.object({
  output: z.array(
    z.object({
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
  usage: z
    .object({
      input_tokens: z.number().nonnegative(),
      output_tokens: z.number().nonnegative(),
      total_tokens: z.number().nonnegative(),
    })
    .optional(),
});

export interface AskAiOptions {
  /** The answer's budget. OpenAI's reasoning tokens come out of it too, so it is doubled there. */
  maxTokens: number;
  timeoutMs: number;
  /** The error code a refusal by the provider is reported under. */
  failureCode: string;
  /** Told when the provider refuses, with its status and message; never the prompt. */
  onRejected?: (status: number, message: string) => void;
}

export async function askAi(
  configuration: ResolvedAiConfiguration,
  prompt: string,
  options: AskAiOptions,
): Promise<{ text: string; usage: AiTokenUsage }> {
  const anthropic = configuration.provider === AiProvider.ANTHROPIC;
  const response = anthropic
    ? await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-api-key': configuration.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: configuration.modelId,
          max_tokens: options.maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
    : await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${configuration.apiKey}`,
        },
        body: JSON.stringify({
          model: configuration.modelId,
          max_output_tokens: options.maxTokens * 2,
          reasoning: { effort: 'low' },
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
        }),
      });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      (payload as { error?: { message?: string } } | null)?.error?.message ?? 'unknown error';
    options.onRejected?.(response.status, message);
    throw new ApplicationError(
      502,
      options.failureCode,
      'The AI provider did not answer. Try again in a minute.',
    );
  }
  if (anthropic) {
    const parsed = anthropicSchema.parse(payload);
    const inputTokens = parsed.usage?.input_tokens ?? 0;
    const outputTokens = parsed.usage?.output_tokens ?? 0;
    return {
      text: parsed.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n'),
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    };
  }
  const parsed = openAiSchema.parse(payload);
  return {
    text: parsed.output
      .flatMap((part) => part.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('\n'),
    usage: {
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
      totalTokens: parsed.usage?.total_tokens ?? 0,
    },
  };
}

/** The JSON in a model's answer, without any fence around it. */
export function jsonIn(text: string, open: '[' | '{') {
  const close = open === '[' ? ']' : '}';
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = stripped.indexOf(open);
  const end = stripped.lastIndexOf(close);
  return start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
}
