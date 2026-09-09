import type { RoomSnapshot } from '../src/domain/models';
import {
  MAX_AUTOMATIC_ATTEMPTS,
  retryPlanFor,
  snapshotsAwaitingUpload,
} from '../src/media/snapshot-upload';

function snapshot(overrides: Partial<RoomSnapshot> & { id: string }): RoomSnapshot {
  return {
    inspectionId: 'insp-1',
    roomId: 'room-1',
    uri: 'file:///snapshot.jpg',
    width: 100,
    height: 100,
    capturedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('whether a failed photo is worth sending again', () => {
  it('gives up on a refusal the server will only repeat', () => {
    // A duplicate key or a finalized inspection answers the same in an hour.
    // Retrying forever is the mistake the video queue already makes.
    expect(retryPlanFor(409, 1)).toEqual({ kind: 'permanent' });
    expect(retryPlanFor(422, 1)).toEqual({ kind: 'permanent' });
  });

  it('keeps trying when the server or the signal is at fault', () => {
    expect(retryPlanFor(503, 1).kind).toBe('retry');
    expect(retryPlanFor(undefined, 1).kind).toBe('retry');
  });

  it('treats the two client errors that mean "try again" as retryable', () => {
    expect(retryPlanFor(408, 1).kind).toBe('retry');
    expect(retryPlanFor(429, 1).kind).toBe('retry');
  });

  it('backs off further each time, up to a ceiling', () => {
    const first = retryPlanFor(503, 1);
    const later = retryPlanFor(503, 4);
    const much = retryPlanFor(503, 6);
    if (first.kind !== 'retry' || later.kind !== 'retry' || much.kind !== 'retry')
      throw new Error('expected retries');
    expect(later.delayMs).toBeGreaterThan(first.delayMs);
    expect(much.delayMs).toBeLessThanOrEqual(5 * 60_000);
  });

  it('stops retrying on its own after enough attempts', () => {
    // Not a deletion — the photo stays with its reason and can be sent by hand.
    expect(retryPlanFor(503, MAX_AUTOMATIC_ATTEMPTS)).toEqual({ kind: 'permanent' });
  });
});

describe('which photos the device still owes the server', () => {
  const now = Date.parse('2026-08-26T12:00:00.000Z');

  it('leaves alone anything already uploaded', () => {
    expect(snapshotsAwaitingUpload([snapshot({ id: 'a', uploadStatus: 'UPLOADED' })], now)).toEqual(
      [],
    );
  });

  it('picks up a failure whose backoff has passed, and skips one still waiting', () => {
    const due = snapshot({
      id: 'due',
      uploadStatus: 'FAILED',
      nextAttemptAt: '2026-08-26T11:59:00.000Z',
    });
    const waiting = snapshot({
      id: 'waiting',
      uploadStatus: 'FAILED',
      nextAttemptAt: '2026-08-26T12:05:00.000Z',
    });

    expect(snapshotsAwaitingUpload([due, waiting], now).map((item) => item.id)).toEqual(['due']);
  });

  it('reclaims one left UPLOADING by a run that died with the app', () => {
    // The idempotency key makes a second attempt safe, and the alternative is
    // a photo stuck in a state nothing ever clears.
    expect(
      snapshotsAwaitingUpload([snapshot({ id: 'a', uploadStatus: 'UPLOADING' })], now).map(
        (item) => item.id,
      ),
    ).toEqual(['a']);
  });

  it('stops offering one that has exhausted its attempts', () => {
    expect(
      snapshotsAwaitingUpload(
        [snapshot({ id: 'a', uploadStatus: 'FAILED', attempts: MAX_AUTOMATIC_ATTEMPTS })],
        now,
      ),
    ).toEqual([]);
  });

  it('sends the oldest photo first', () => {
    const later = snapshot({ id: 'later', capturedAt: '2026-08-26T10:00:00.000Z' });
    const earlier = snapshot({ id: 'earlier', capturedAt: '2026-08-26T09:00:00.000Z' });

    expect(snapshotsAwaitingUpload([later, earlier], now).map((item) => item.id)).toEqual([
      'earlier',
      'later',
    ]);
  });
});

describe('a photograph the server refused outright', () => {
  const now = Date.parse('2026-08-26T12:00:00.000Z');

  /**
   * The bug this pins. `retryPlanFor` answers `permanent` for a 409, and
   * `uploadSnapshotNow` records that by clearing `nextAttemptAt` — but an
   * absent `nextAttemptAt` also means "due now". So a photograph the server had
   * refused outright came back due on every pass, for ever, after a single
   * attempt.
   *
   * Survivable at one photograph per four seconds. Not survivable once the
   * queue drains: the doomed item sorts first by capture time, so it would be
   * retried on every iteration while the photographs behind it waited.
   */
  it('is not owed again once it has been refused', () => {
    const refused = snapshot({
      id: 'refused',
      uploadStatus: 'FAILED',
      attempts: 1,
      lastError: 'This photo key was already used for another area.',
      nextAttemptAt: undefined,
    });
    expect(snapshotsAwaitingUpload([refused], now)).toEqual([]);
  });

  it('does not hold up the photographs captured after it', () => {
    const refused = snapshot({
      id: 'refused',
      capturedAt: '2026-08-26T11:00:00.000Z',
      uploadStatus: 'FAILED',
      attempts: 1,
      nextAttemptAt: undefined,
    });
    const waiting = snapshot({ id: 'waiting', capturedAt: '2026-08-26T11:30:00.000Z' });
    expect(snapshotsAwaitingUpload([refused, waiting], now).map((item) => item.id)).toEqual([
      'waiting',
    ]);
  });

  it('still owes a photograph that has never been attempted', () => {
    // The other half of the same rule. An absent `nextAttemptAt` is how a fresh
    // capture is marked, and reading it as "finished" would mean nothing was
    // ever uploaded at all.
    expect(snapshotsAwaitingUpload([snapshot({ id: 'fresh' })], now).map((item) => item.id)).toEqual(
      ['fresh'],
    );
  });

  it('still owes one that failed and is waiting to be retried', () => {
    const retrying = snapshot({
      id: 'retrying',
      uploadStatus: 'FAILED',
      attempts: 1,
      nextAttemptAt: '2026-08-26T11:59:00.000Z',
    });
    expect(snapshotsAwaitingUpload([retrying], now).map((item) => item.id)).toEqual(['retrying']);
  });
});
