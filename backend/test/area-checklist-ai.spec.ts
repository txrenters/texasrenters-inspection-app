import { AreaChecklistAiService } from '../src/admin/area-checklist-ai.service';

const CONFIG = {
  provider: 'ANTHROPIC',
  modelId: 'test-model',
  apiKey: 'private-test-key',
} as never;

const AREAS = [
  { name: 'Front Staircase', category: 'STAIRWAY', environment: 'INDOOR' as const },
  { name: 'Kitchen', category: 'INDOOR_ROOM', environment: 'INDOOR' as const },
];

/** An Anthropic-shaped reply carrying `text` as the model's answer. */
function reply(text: string, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => ({ content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 2 } }),
  } as never;
}

describe('area checklist generation', () => {
  const service = new AreaChecklistAiService();
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('uses what the model returns, deduplicated and trimmed', async () => {
    fetchMock.mockResolvedValue(
      reply(
        JSON.stringify([
          // The point of the whole exercise: a staircase with no doors, no
          // locks and no windows.
          { index: 0, items: ['  Floor and coverings ', 'Walls and ceilings', 'walls and CEILINGS'] },
          { index: 1, items: ['Sink, taps and spouts', 'Refrigerator'] },
        ]),
      ),
    );

    const result = await service.generate(AREAS, CONFIG);

    expect(result.items[0]).toEqual(['Floor and coverings', 'Walls and ceilings']);
    expect(result.items[0]).not.toContain('Doors and locks');
    expect(result.items[1]).toEqual(['Sink, taps and spouts', 'Refrigerator']);
    expect(result.fellBack).toBe(false);
  });

  it('falls back per area, not all-or-nothing', async () => {
    // One skipped area must not discard good lists for the others.
    fetchMock.mockResolvedValue(reply(JSON.stringify([{ index: 1, items: ['Refrigerator'] }])));

    const result = await service.generate(AREAS, CONFIG);

    expect(result.items[1]).toEqual(['Refrigerator']);
    expect(result.items[0]).toEqual(service.fallbackFor(AREAS[0]!));
    expect(result.items[0]!.length).toBeGreaterThan(0);
  });

  it.each([
    ['a provider error', () => reply('', false, 500)],
    ['prose instead of JSON', () => reply('Sure! Here are the checklists.')],
    ['a schema violation', () => reply(JSON.stringify([{ index: 0, items: [] }]))],
    ['an empty reply', () => reply('')],
  ])('falls back to the templates on %s', async (_label, response) => {
    fetchMock.mockResolvedValue(response());

    const result = await service.generate(AREAS, CONFIG);

    // Never empty. A missing checklist is worse than a conservative one: it
    // leaves the technician with nothing to cover and no sign of the gap.
    expect(result.fellBack).toBe(true);
    expect(result.items).toHaveLength(2);
    for (const items of result.items) expect(items.length).toBeGreaterThan(0);
  });

  it('does not call a provider when none is configured', async () => {
    const result = await service.generate(AREAS, undefined);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.fellBack).toBe(true);
    expect(result.items[1]).toEqual(service.fallbackFor(AREAS[1]!));
  });

  it('survives a network failure rather than losing the extraction', async () => {
    // The areas are already extracted by this point; throwing here would
    // discard the expensive half of the work over the cheap half.
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    await expect(service.generate(AREAS, CONFIG)).resolves.toMatchObject({ fellBack: true });
  });
});
