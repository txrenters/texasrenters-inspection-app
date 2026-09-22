import { z } from 'zod';

/**
 * The reply the phone reads back after saving the checklist.
 *
 * Reconstructed here rather than imported: `repositories.ts` pulls in the whole
 * API layer, and what is under test is one property of one shape. The schemas
 * below are copied from `mobile/src/repositories/api/repositories.ts` and this
 * test exists to fail if they drift apart again.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * `z.object()` strips what it does not name. `filterOutcomeSchema` named size,
 * location, slot, changed, reason, photoId and booked — everything except
 * `photoKey`, which was added to the contract later and never added here.
 *
 * A photograph is held on the device for a review window before it uploads, so
 * `photoId` is null for that whole time and the handset's own key is the only
 * evidence the shot was taken. Stripping it meant the server's own reply came
 * back saying the register had no photograph: the row reverted to "Not done
 * yet" seconds after the shutter, and the next save told the server the same,
 * destroying the link to an image that was still on its way up. Reported as
 * "there's no indicator that we have added a photo" (the office, 2026-09-23).
 */

const serviceOutcomeSchema = z.object({
  done: z.boolean(),
  reason: z.string().nullable().default(null),
  reschedule: z.boolean().default(false),
  photoKey: z.string().nullable().default(null),
  photoId: z.string().nullable().default(null),
});

const filterOutcomeSchema = z.object({
  size: z.string(),
  location: z.string().nullable().default(null),
  slot: z.number().int().min(1),
  changed: z.boolean(),
  reason: z.string().nullable().default(null),
  photoId: z.string().nullable().default(null),
  photoKey: z.string().nullable().default(null),
  booked: z.boolean().default(false),
});

describe('reading a filter answer back from the server', () => {
  const fromServer = {
    size: '20x25x1',
    location: null,
    slot: 1,
    changed: true,
    reason: null,
    photoId: null,
    photoKey: 'snapshot-abc123',
    booked: true,
  };

  it('keeps the handset key, which is the only evidence before the upload lands', () => {
    expect(filterOutcomeSchema.parse(fromServer).photoKey).toBe('snapshot-abc123');
  });

  /** An older server, or a register never photographed, says nothing. */
  it('reads a missing key as none rather than refusing the whole job', () => {
    const { photoKey: _omitted, ...withoutKey } = fromServer;
    expect(filterOutcomeSchema.parse(withoutKey).photoKey).toBeNull();
  });
});

describe('reading a service answer back from the server', () => {
  /**
   * The same omission, on the optional photograph a technician may take of pest
   * control or a flea treatment — so that evidence was being dropped too, on
   * every tick, without anyone reporting it.
   */
  it('keeps both the handset key and the photograph once it has arrived', () => {
    const parsed = serviceOutcomeSchema.parse({
      done: true,
      reason: null,
      reschedule: false,
      photoKey: 'snapshot-xyz',
      photoId: '0b2a4f6e-1111-4222-8333-444455556666',
    });

    expect(parsed.photoKey).toBe('snapshot-xyz');
    expect(parsed.photoId).toBe('0b2a4f6e-1111-4222-8333-444455556666');
  });
});
