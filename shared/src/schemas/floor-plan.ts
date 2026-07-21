import { z } from 'zod';

export const extractedAreaSchema = z.object({
  floorName: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  inspectionOrder: z.number().int().positive(),
  isRequired: z.boolean(),
});

export const floorPlanExtractionSchema = z
  .array(extractedAreaSchema)
  .min(1)
  .max(100)
  .superRefine((areas, context) => {
    const names = new Set<string>();
    areas.forEach((area, index) => {
      const key = `${area.floorName.toLocaleLowerCase()}:${area.name.toLocaleLowerCase()}`;
      if (names.has(key))
        context.addIssue({
          code: 'custom',
          message: 'Duplicate room name on the same floor',
          path: [index, 'name'],
        });
      names.add(key);
    });
  });

export type ExtractedArea = z.infer<typeof extractedAreaSchema>;
