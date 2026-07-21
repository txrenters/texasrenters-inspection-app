import { describe, expect, it } from 'vitest';

import { aiFindingSchema, floorPlanExtractionSchema } from '../src/index.js';

describe('external payload schemas', () => {
  it('rejects invalid finding timestamps and confidence', () => {
    const result = aiFindingSchema.safeParse({
      propertyAreaId: 'not-a-uuid',
      areaName: '',
      confidence: 2,
      videoTimestampStart: 20,
      videoTimestampEnd: 10,
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate room names on one floor', () => {
    const result = floorPlanExtractionSchema.safeParse([
      { floorName: 'Ground Floor', name: 'Kitchen', inspectionOrder: 1, isRequired: true },
      { floorName: 'Ground Floor', name: 'kitchen', inspectionOrder: 2, isRequired: true },
    ]);
    expect(result.success).toBe(false);
  });

  it('bounds AI floor-plan output before persistence', () => {
    const result = floorPlanExtractionSchema.safeParse(
      Array.from({ length: 101 }, (_, index) => ({
        floorName: 'Ground Floor',
        name: `Area ${index + 1}`,
        inspectionOrder: index + 1,
        isRequired: true,
      })),
    );
    expect(result.success).toBe(false);
  });
});
