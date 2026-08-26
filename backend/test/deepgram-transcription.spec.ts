import {
  deepgramApiKey,
  parseDeepgramResponse,
  requestDeepgramTranscription,
  requestDeepgramTranscriptionFromUrl,
} from '../src/technician/deepgram-transcription';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const payload = (overrides: Record<string, unknown> = {}) => ({
  results: {
    channels: [
      { alternatives: [{ transcript: 'The kitchen sink is leaking.' }], detected_language: 'en' },
    ],
    utterances: [
      { start: 1.2, end: 4.8, transcript: 'The kitchen sink is leaking.' },
      { start: 5.0, end: 7.5, transcript: 'Grout is cracked behind the tap.' },
    ],
    ...overrides,
  },
});

describe('parsing a Deepgram response', () => {
  it('keeps real per-utterance timings', () => {
    // The reason for choosing Deepgram. Without these the whole narration was
    // one segment spanning the video, so every AI finding's timestamp was a
    // guess and a reviewer seeking to it landed at 0:00 every time.
    const result = parseDeepgramResponse(payload(), 120);
    expect(result.segments).toEqual([
      { startSeconds: 1.2, endSeconds: 4.8, text: 'The kitchen sink is leaking.' },
      { startSeconds: 5, endSeconds: 7.5, text: 'Grout is cracked behind the tap.' },
    ]);
  });

  it('takes the full text from the channel, not by joining utterances', () => {
    // Joining would silently drop anything Deepgram did not group.
    const result = parseDeepgramResponse(payload(), 120);
    expect(result.text).toBe('The kitchen sink is leaking.');
  });

  it('clamps a timestamp that runs past the recording', () => {
    // A finding placed beyond the end is a timestamp the player cannot seek to.
    const result = parseDeepgramResponse(
      payload({ utterances: [{ start: 0, end: 999, transcript: 'Overrun.' }] }),
      30,
    );
    expect(result.segments?.[0]?.endSeconds).toBe(30);
  });

  it('reports the detected language rather than assuming English', () => {
    // Narration may be in any language; the crew is multilingual.
    const spanish = payload();
    spanish.results.channels[0]!.detected_language = 'es';
    expect(parseDeepgramResponse(spanish, 60).language).toBe('es');
  });

  it('drops empty utterances instead of storing blank segments', () => {
    const result = parseDeepgramResponse(
      payload({ utterances: [{ start: 0, end: 1, transcript: '   ' }] }),
      60,
    );
    expect(result.segments).toBeNull();
  });

  it('falls back to no segments when utterances are absent', () => {
    // The caller then stores one whole-recording segment, exactly as the OpenAI
    // path always did.
    const withoutUtterances = { results: { channels: payload().results.channels } };
    expect(parseDeepgramResponse(withoutUtterances, 60).segments).toBeNull();
  });

  it('refuses an unreadable payload rather than storing an empty transcript', () => {
    for (const bad of [null, {}, { results: {} }, { results: { channels: [] } }])
      expect(() => parseDeepgramResponse(bad, 60)).toThrow(/unreadable/i);
  });
});

describe('calling Deepgram', () => {
  const audio = { bytes: Buffer.from('fake-audio'), type: 'audio/mp4' };

  it('asks for utterances and language detection', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload(),
    });
    await requestDeepgramTranscription('dg-key', audio, 120, fetchMock as never);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('utterances=true');
    expect(url).toContain('detect_language=true');
    // Domain vocabulary, for accented narration in a tiled bathroom.
    expect(url).toContain('keyterm=');
    expect((init.headers as Record<string, string>).Authorization).toBe('Token dg-key');
  });

  it('names the credential when Deepgram rejects it', async () => {
    // A 401 here is a backend configuration problem, and the message has to say
    // which variable to look at.
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    await expect(
      requestDeepgramTranscription('bad', audio, 120, fetchMock as never),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' });
    await expect(
      requestDeepgramTranscription('bad', audio, 120, fetchMock as never),
    ).rejects.toThrow(/DEEPGRAM_API_KEY/);
  });

  it('never puts the key in a transport error', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const error = await requestDeepgramTranscription(
      'super-secret-key',
      audio,
      120,
      fetchMock as never,
    ).catch((thrown: Error) => thrown);
    expect(`${JSON.stringify(error)}${String(error)}`).not.toContain('super-secret-key');
  });

  it('treats a server fault as retryable rather than a credential problem', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 502 });
    await expect(
      requestDeepgramTranscription('dg-key', audio, 120, fetchMock as never),
    ).rejects.toThrow(/Retry from the uploads screen/);
  });
});

describe('provider selection', () => {
  it('is available only when the backend holds a key', () => {
    delete process.env.DEEPGRAM_API_KEY;
    expect(deepgramApiKey()).toBeNull();
    process.env.DEEPGRAM_API_KEY = '  dg-key  ';
    expect(deepgramApiKey()).toBe('dg-key');
  });

  it('treats a blank value as absent', () => {
    // An empty variable in a .env file must not look like a configured provider.
    process.env.DEEPGRAM_API_KEY = '   ';
    expect(deepgramApiKey()).toBeNull();
  });
});

describe('transcribing media Deepgram fetches itself', () => {
  it('sends a URL instead of bytes', async () => {
    // Cloudflare Stream recordings never touch this backend. Downloading a
    // walkthrough here purely to forward it to Deepgram would reintroduce the
    // transfer the Stream migration removed, on a server rather than a phone.
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload(),
    });
    await requestDeepgramTranscriptionFromUrl(
      'dg-key',
      'https://customer-abc.cloudflarestream.com/uid/downloads/default.mp4',
      120,
      fetchMock as never,
    );

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'https://customer-abc.cloudflarestream.com/uid/downloads/default.mp4',
    });
  });

  it('asks for the same timings as the byte path', async () => {
    // Both paths must produce segments a finding can be anchored to; a Stream
    // recording should not silently lose them.
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => payload() });
    const result = await requestDeepgramTranscriptionFromUrl(
      'dg-key',
      'https://host/a.mp4',
      120,
      fetchMock as never,
    );
    expect(fetchMock.mock.calls[0][0]).toContain('utterances=true');
    expect(result.segments).toHaveLength(2);
  });

  it('never puts the signed media URL in a transport error', async () => {
    // That URL is a short-lived credential for the recording itself.
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const error = await requestDeepgramTranscriptionFromUrl(
      'dg-key',
      'https://host/uid/downloads/default.mp4?sig=secret-signature',
      120,
      fetchMock as never,
    ).catch((thrown: Error) => thrown);
    expect(`${JSON.stringify(error)}${String(error)}`).not.toContain('secret-signature');
  });
});
