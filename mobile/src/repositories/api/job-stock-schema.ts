import { z } from 'zod';

import { phoneCatalogSchema } from './phone-catalog-schema';

/**
 * What the server answers for a job's materials (2026-11-19, phase 7).
 *
 * Every field the screen reads is named here: a schema drops what it does not
 * name, and what is dropped here is gone from the screen and from the copy
 * kept for when there is no signal. The value survives parse, JSON and parse
 * again (tests/job-stock.test.ts), because that is how the kept copy is read.
 */
const itemSchema = z.object({ itemId: z.string(), code: z.string(), name: z.string(), unit: z.string(), quantity: z.number() });

export const jobStockSchema = z.object({
  places: z.array(z.object({ id: z.string(), name: z.string() })),
  stock: z.array(itemSchema.extend({ placeId: z.string() })),
  slips: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      kind: z.enum(['WITHDRAWAL', 'RETURN']),
      at: z.string(),
      place: z.string(),
      reversed: z.boolean(),
      lines: z.array(itemSchema),
    }),
  ),
  taken: z.array(itemSchema),
  // 2026-11-24: a search finds an item with none in the truck, and a scan tells a code that is no item from one not in the truck.
  catalog: phoneCatalogSchema,
});
