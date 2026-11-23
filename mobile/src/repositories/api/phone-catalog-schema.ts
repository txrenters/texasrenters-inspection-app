import { z } from 'zod';

/**
 * Every item in use, as the server sends it with a job's materials and with
 * the truck counts (2026-11-24): what a search finds, and how a scan tells a
 * code that is no item from an item that is not on this truck.
 *
 * A copy kept on the phone before the server sent it has none, so it reads
 * as an empty list rather than failing.
 */
export const phoneCatalogSchema = z.array(z.object({ itemId: z.string(), code: z.string(), name: z.string(), unit: z.string() })).default([]);
