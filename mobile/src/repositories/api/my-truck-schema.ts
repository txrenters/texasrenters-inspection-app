import { z } from 'zod';

import { phoneCatalogSchema } from './phone-catalog-schema';

/**
 * What the server answers for My truck (2026-11-24).
 *
 * Every field the screen reads is named here: a schema drops what it does not
 * name, and what is dropped here is gone from the screen and from the copy
 * kept for when there is no signal.
 */
const askSchema = z.object({
  id: z.string(),
  place: z.object({ id: z.string(), name: z.string() }),
  askedBy: z.object({ id: z.string(), name: z.string() }),
  at: z.string(),
  note: z.string().nullable(),
  status: z.enum(['ASKED', 'FILLED']),
  lines: z.array(z.object({ itemId: z.string(), code: z.string(), name: z.string(), unit: z.string(), quantity: z.number() })),
  filled: z.object({ slipNumber: z.string(), at: z.string(), by: z.string() }).nullable(),
});

export const myTrucksSchema = z.object({
  trucks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      mine: z.boolean(),
      lastCountedOn: z.string().nullable(),
      items: z.array(z.object({ itemId: z.string(), code: z.string(), name: z.string(), unit: z.string(), onHand: z.number(), keepAtLeast: z.number().nullable() })),
      asks: z.array(askSchema),
    }),
  ),
  slips: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      kind: z.enum(['WITHDRAWAL', 'RETURN']),
      at: z.string(),
      place: z.string(),
      job: z.object({ id: z.string(), address: z.string().nullable() }).nullable(),
      lines: z.array(z.object({ code: z.string(), name: z.string(), quantity: z.number() })),
      reversed: z.boolean(),
    }),
  ),
  catalog: phoneCatalogSchema,
});
