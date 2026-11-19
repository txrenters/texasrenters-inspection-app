import { z } from 'zod';

/**
 * What the server answers for the truck counts a technician may count
 * (2026-11-19).
 *
 * Every field the screen reads is named here: a schema drops what it does not
 * name, and what is dropped is gone from the screen and from the copy kept
 * for when there is no signal. There is no expected number to name: the
 * server never sends one.
 */
const lineSchema = z.object({
  lineId: z.string(),
  itemId: z.string(),
  code: z.string(),
  name: z.string(),
  unit: z.string(),
  counted: z.number().nullable(),
  second: z.boolean(),
});

export const truckCountsSchema = z.object({
  counts: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      title: z.string(),
      place: z.object({ id: z.string(), name: z.string() }),
      lines: z.array(lineSchema),
    }),
  ),
});

export const truckCountSavedSchema = truckCountsSchema.extend({
  outcome: z.enum(['saved', 'handed-in', 'recount', 'already']),
  recounts: z.number(),
});
