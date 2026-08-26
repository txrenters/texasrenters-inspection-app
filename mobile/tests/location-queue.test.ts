import {
  MAX_QUEUE_LENGTH,
  deferFixes,
  fixesToSend,
  retryDelayMs,
  trimQueue,
  unsendableFixes,
  type QueuedFix,
} from '../src/location/location-queue';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const fix = (over: Partial<QueuedFix> & { id: string }): QueuedFix => ({
  latitude: 30.2672,
  longitude: -97.7431,
  recordedAt: at(1),
  ...over,
});

describe('which queued fixes go next', () => {
  it('sends the oldest first', () => {
    // A queue drained after an outage is stored in arrival order; sending it
    // that way would draw the route backwards.
    const later = fix({ id: 'later', recordedAt: at(1) });
    const earlier = fix({ id: 'earlier', recordedAt: at(30) });
    expect(fixesToSend([later, earlier], NOW).map((item) => item.id)).toEqual(['earlier', 'later']);
  });

  it('leaves a backed-off fix alone until it is due', () => {
    const waiting = fix({ id: 'waiting', nextAttemptAt: new Date(NOW + 60_000).toISOString() });
    const due = fix({ id: 'due', nextAttemptAt: new Date(NOW - 1_000).toISOString() });
    expect(fixesToSend([waiting, due], NOW).map((item) => item.id)).toEqual(['due']);
  });

  it('never offers a fix the API would refuse', () => {
    // Spending a handset's signal on something the server will reject is the
    // one cost this queue cannot afford in the field.
    const impossible = fix({ id: 'bad', latitude: 91 });
    expect(fixesToSend([impossible], NOW)).toEqual([]);
  });

  it('bounds a batch so a long outage does not send one enormous request', () => {
    const many = Array.from({ length: 500 }, (_, index) =>
      fix({ id: `fix-${index}`, recordedAt: at(500 - index) }),
    );
    expect(fixesToSend(many, NOW).length).toBeLessThanOrEqual(200);
  });
});

describe('what is not worth keeping', () => {
  it('identifies fixes that will never be accepted', () => {
    // A wrong clock does not become right, and a queue that keeps retrying one
    // never drains past it.
    const good = fix({ id: 'good' });
    const futureClock = fix({
      id: 'future',
      recordedAt: new Date(NOW + 60 * 60_000).toISOString(),
    });
    expect(unsendableFixes([good, futureClock], NOW).map((item) => item.id)).toEqual(['future']);
  });

  it('drops the oldest once the queue is full, not the newest', () => {
    // "Where are they now" is the question this answers, so recent history is
    // the part worth keeping when something has to go.
    const over = Array.from({ length: MAX_QUEUE_LENGTH + 10 }, (_, index) =>
      fix({
        id: `fix-${index}`,
        recordedAt: new Date(NOW - (MAX_QUEUE_LENGTH + 10 - index) * 1_000).toISOString(),
      }),
    );
    const trimmed = trimQueue(over);
    expect(trimmed).toHaveLength(MAX_QUEUE_LENGTH);
    expect(trimmed.at(-1)?.id).toBe(`fix-${MAX_QUEUE_LENGTH + 9}`);
    expect(trimmed.some((item) => item.id === 'fix-0')).toBe(false);
  });
});

describe('backing off a failed send', () => {
  it('waits longer each time, up to a ceiling', () => {
    expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(1));
    expect(retryDelayMs(20)).toBeLessThanOrEqual(10 * 60_000);
  });

  it('defers only the batch that failed, and keeps everything', () => {
    // Never dropped: a failure here is almost always a property with no
    // signal, and discarding the trail because the radio was busy is exactly
    // what this queue exists to prevent.
    const sent = fix({ id: 'sent' });
    const untouched = fix({ id: 'untouched' });
    const after = deferFixes([sent, untouched], ['sent'], NOW);

    expect(after).toHaveLength(2);
    expect(after.find((item) => item.id === 'sent')?.attempts).toBe(1);
    expect(after.find((item) => item.id === 'sent')?.nextAttemptAt).toBeDefined();
    expect(after.find((item) => item.id === 'untouched')?.nextAttemptAt).toBeUndefined();
  });
});
