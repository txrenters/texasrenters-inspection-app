import { z } from 'zod';

/**
 * What the model is allowed to return when asked for area checklists.
 *
 * Areas are matched back by **index**, not by name. Three areas called "Living
 * area" is normal in this data, and matching on the name would give all three
 * whichever list came back first.
 */
export const areaChecklistGenerationSchema = z
  .array(
    z.object({
      index: z.number().int().nonnegative(),
      items: z
        .array(z.string().trim().min(2).max(80))
        // At least one: an area with no items leaves the technician nothing to
        // cover and no sign anything is missing. At most twenty: past that the
        // model has started itemising fixtures rather than describing an area,
        // and the list stops being walkable.
        .min(1)
        .max(20),
    }),
  )
  .min(1);

export type AreaChecklistGeneration = z.infer<typeof areaChecklistGenerationSchema>;
