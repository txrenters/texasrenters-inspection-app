import { z } from 'zod';

import { ApplicationError } from '../common/errors';

/**
 * Transcription via Deepgram.
 *
 * Kept in its own file so the network call and the response parsing can be
 * tested without a Deepgram account, and so the credential has one home.
 *
 * Chosen over the OpenAI path for two reasons that matter here. Deepgram
 * returns **per-utterance timestamps**, where OpenAI's JSON response carries
 * none — so the whole narration used to be stored as a single segment spanning
 * the entire video, and every AI finding's `videoTimestampStart` was a guess.
 * It also handles accented and non-native narration well, which is the crew
 * this app is actually used by.
 */

const API_URL = 'https://api.deepgram.com/v1/listen';

/**
 * Vocabulary the model is told to expect.
 *
 * Inspection narration is full of words a general model mishears — "architrave",
 * "skirting", "efflorescence" — and a technician saying them with an accent in a
 * tiled bathroom is the hardest case this system has.
 */
const DOMAIN_TERMS = [
  'architrave',
  'skirting',
  'efflorescence',
  'grout',
  'sealant',
  'downpipe',
  'fascia',
  'laminate',
  'vanity',
  'extractor',
];

const responseSchema = z.object({
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z.array(z.object({ transcript: z.string() })).min(1),
          detected_language: z.string().optional(),
        }),
      )
      .min(1),
    utterances: z
      .array(z.object({ start: z.number(), end: z.number(), transcript: z.string() }))
      .optional(),
  }),
});

export interface TranscriptSegmentInput {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  /** Real timings when the provider gives them; null when it does not. */
  segments: TranscriptSegmentInput[] | null;
  language: string | null;
  provider: string;
}

/**
 * Turn a Deepgram payload into segments.
 *
 * Exported for its own sake: this is where a provider response becomes evidence
 * an AI will summarize and a reviewer will seek to, so it is worth testing
 * directly rather than only through a network mock.
 */
export function parseDeepgramResponse(payload: unknown, durationSeconds: number): TranscriptionResult {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success)
    throw new ApplicationError(
      502,
      'TRANSCRIPTION_FAILED',
      'The transcription provider returned an unreadable response.',
    );

  const channel = parsed.data.results.channels[0]!;
  const utterances = parsed.data.results.utterances ?? [];
  const segments = utterances
    .filter((utterance) => utterance.transcript.trim().length > 0)
    .map((utterance) => ({
      // Clamped to the recording: a provider timestamp past the end would place
      // a finding at a moment the player cannot seek to.
      startSeconds: Math.max(0, Math.min(utterance.start, durationSeconds)),
      endSeconds: Math.max(0, Math.min(utterance.end, durationSeconds)),
      text: utterance.transcript.trim(),
    }));

  return {
    // The channel alternative is the authoritative full text; joining utterances
    // would drop anything Deepgram did not group into one.
    text: channel.alternatives[0]!.transcript.trim(),
    segments: segments.length ? segments : null,
    language: channel.detected_language ?? null,
    provider: 'deepgram',
  };
}

export async function requestDeepgramTranscription(
  apiKey: string,
  audio: { bytes: Buffer; type: string },
  durationSeconds: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TranscriptionResult> {
  const query = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    punctuate: 'true',
    // The reason for choosing Deepgram: timings per utterance.
    utterances: 'true',
    // Never hardcode English — narrations may be in any language, and the crew
    // is multilingual.
    detect_language: 'true',
  });
  for (const term of DOMAIN_TERMS) query.append('keyterm', term);

  let response: Response;
  try {
    response = await fetchImpl(`${API_URL}?${query.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': audio.type },
      body: new Uint8Array(audio.bytes),
    });
  } catch {
    // Deliberately says nothing about the request: its headers carry the key.
    throw new ApplicationError(
      502,
      'TRANSCRIPTION_FAILED',
      'The recording could not be transcribed. Retry from the uploads screen.',
    );
  }

  if (!response.ok) {
    const rejected = response.status === 401 || response.status === 403;
    throw new ApplicationError(
      rejected ? 503 : 502,
      'TRANSCRIPTION_FAILED',
      rejected
        ? 'The Deepgram credential was rejected. Check DEEPGRAM_API_KEY on the backend.'
        : 'The recording could not be transcribed. Retry from the uploads screen.',
    );
  }

  return parseDeepgramResponse(await response.json().catch(() => null), durationSeconds);
}

/** Whether Deepgram is available on this deployment. */
export function deepgramApiKey() {
  return process.env.DEEPGRAM_API_KEY?.trim() || null;
}
