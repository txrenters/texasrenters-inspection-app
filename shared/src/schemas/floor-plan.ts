import { z } from 'zod';

// Normalized image coordinate: a fraction of the source image/page in [0, 1].
// Plain number (no coercion) so null/string/missing never becomes a silent 0.
const normalizedCoordinate = z.number().min(0).max(1);

export const areaMarkerSchema = z.object({
  x: normalizedCoordinate,
  y: normalizedCoordinate,
  confidence: normalizedCoordinate.optional(),
});

export const areaBoundingBoxSchema = z.object({
  x: normalizedCoordinate,
  y: normalizedCoordinate,
  width: normalizedCoordinate,
  height: normalizedCoordinate,
});

export const extractedAreaSchema = z.object({
  floorName: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  inspectionOrder: z.number().int().positive(),
  isRequired: z.boolean(),
  // Optional spatial marker + bounding box. `.catch(undefined)` keeps the area
  // when the model returns a missing/out-of-range coordinate — a bad marker is
  // dropped (rendered "unavailable"), it never fails the whole extraction (§5).
  marker: areaMarkerSchema.optional().catch(undefined),
  boundingBox: areaBoundingBoxSchema.optional().catch(undefined),
});

export type AreaMarker = z.infer<typeof areaMarkerSchema>;
export type AreaBoundingBox = z.infer<typeof areaBoundingBoxSchema>;

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
