import { z } from 'zod';

import { ComparisonResult, ResponsibilityClassification, Severity } from '../enums/index.js';

export const aiFindingSchema = z
  .object({
    propertyAreaId: z.uuid(),
    areaName: z.string().trim().min(1),
    findingType: z.enum(['possible_new_damage', 'existing_condition', 'maintenance', 'no_change']),
    category: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    baselineCondition: z.string().trim().min(1),
    comparisonResult: z.enum(ComparisonResult),
    videoTimestampStart: z.number().int().min(0),
    videoTimestampEnd: z.number().int().min(0),
    severity: z.enum(Severity),
    possibleResponsibility: z.enum(ResponsibilityClassification),
    confidence: z.number().min(0).max(1),
    recommendedReview: z.string().trim().min(1),
  })
  .refine((value) => value.videoTimestampEnd >= value.videoTimestampStart, {
    message: 'videoTimestampEnd must be greater than or equal to videoTimestampStart',
    path: ['videoTimestampEnd'],
  });

export const aiFindingListSchema = z.array(aiFindingSchema).min(1);
export type AiFinding = z.infer<typeof aiFindingSchema>;
