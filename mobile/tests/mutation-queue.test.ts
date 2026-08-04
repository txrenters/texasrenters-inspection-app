import {
  QUEUE_ENTRY_MAX_ATTEMPTS,
  drainQueue,
  enqueueMutation,
  readQueue,
  recordAttempt,
  removeMutation,
} from '../src/storage/mutation-queue';

// Prefixed `mock` so jest permits the hoisted factory below to reference it.
const mockStore = new Map<string, string>();

jest.mock('../src/storage/demo-storage', () => ({
  demoStorage: {
    getItem: async (key: string) => mockStore.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      mockStore.set(key, value);
    },
    removeItem: async (key: string) => {
      mockStore.delete(key);
    },
  },
}));

beforeEach(() => mockStore.clear());

const note = (id: string, text: string) => ({ id, kind: 'room-note', payload: { text } });

describe('mutation queue', () => {
  it('keeps only the last write for a target', async () => {
    // Two edits to the same note should send the final value once. Correct
    // only because every queued write sets a value rather than appending one.
    await enqueueMutation(note('room-1', 'first'));
    await enqueueMutation(note('room-1', 'second'));
    const queue = await readQueue();

    expect(queue).toHaveLength(1);
    expect(queue[0]!.payload).toEqual({ text: 'second' });
  });

  it('keeps writes for different targets apart', async () => {
    await enqueueMutation(note('room-1', 'kitchen'));
    await enqueueMutation(note('room-2', 'garage'));
    expect(await readQueue()).toHaveLength(2);
  });

  it('sends oldest first and clears what went out', async () => {
    await enqueueMutation(note('room-1', 'first'));
    await enqueueMutation(note('room-2', 'second'));
    const sent: string[] = [];

    const result = await drainQueue(async (entry) => {
      sent.push(entry.id);
    });

    expect(sent).toEqual(['room-1', 'room-2']);
    expect(result).toEqual({ sent: 2, remaining: 0 });
    expect(await readQueue()).toHaveLength(0);
  });

  it('stops at the first failure instead of burning the rest', async () => {
    // A send usually fails because the network went away again. Working
    // through the remaining entries only spends their attempts against a
    // connection that is already gone.
    await enqueueMutation(note('room-1', 'first'));
    await enqueueMutation(note('room-2', 'second'));
    const tried: string[] = [];

    const result = await drainQueue(async (entry) => {
      tried.push(entry.id);
      throw new Error('offline');
    });

    expect(tried).toEqual(['room-1']);
    expect(result).toEqual({ sent: 0, remaining: 2 });
    expect((await readQueue())[0]!.attempts).toBe(1);
  });

  it('drops an entry that has failed too many times', async () => {
    await enqueueMutation(note('room-1', 'first'));
    for (let attempt = 0; attempt < QUEUE_ENTRY_MAX_ATTEMPTS; attempt += 1) {
      await recordAttempt('room-1');
    }
    expect(await readQueue()).toHaveLength(0);
  });

  it('survives corrupt storage rather than refusing to start', async () => {
    // A technician cannot fix corrupt storage, and refusing to load is worse
    // than losing entries that could not have been sent anyway.
    mockStore.set('texasrenters-mutation-queue-v1', 'not json');
    expect(await readQueue()).toEqual([]);

    mockStore.set('texasrenters-mutation-queue-v1', JSON.stringify([{ nonsense: true }]));
    expect(await readQueue()).toEqual([]);
  });

  it('removes a single entry without disturbing the rest', async () => {
    await enqueueMutation(note('room-1', 'first'));
    await enqueueMutation(note('room-2', 'second'));
    await removeMutation('room-1');

    const queue = await readQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.id).toBe('room-2');
  });
});
