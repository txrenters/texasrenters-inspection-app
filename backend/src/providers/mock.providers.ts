import { Injectable } from '@nestjs/common';
import {
  aiFindingListSchema,
  ComparisonResult,
  floorPlanExtractionSchema,
  ResponsibilityClassification,
  Severity,
  type AiFinding,
  type ExtractedArea,
} from '@texasrenters/shared';

export interface FloorPlanExtractionProvider {
  extract(): ExtractedArea[];
}
export interface VideoPlatformProvider {
  createUploadSession(idempotencyKey: string): {
    providerUploadId: string;
    uploadUrl: string;
    expiresAt: string;
  };
}
export interface TranscriptionProvider {
  transcribe(): { language: string; confidence: number; segments: TranscriptSegment[] };
}
export interface AiAnalysisProvider {
  analyze(propertyAreaId: string, areaName: string): AiFinding[];
}
export interface JobQueueProvider {
  enqueue<T>(name: string, job: () => T): T;
}
export interface FloorPlanStorageProvider {
  register(fileName: string): string;
}
export interface WebhookSignatureVerifier {
  verify(rawBody: string, signature: string | undefined): boolean;
}

export interface TranscriptSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
  confidence: number;
}

@Injectable()
export class MockFloorPlanExtractionProvider implements FloorPlanExtractionProvider {
  extract() {
    return floorPlanExtractionSchema.parse(
      [
        ['Ground Floor', 'Entryway'],
        ['Ground Floor', 'Living Area'],
        ['Ground Floor', 'Kitchen'],
        ['Ground Floor', 'Dining Area'],
        ['Ground Floor', 'Common Bathroom'],
        ['Ground Floor', 'Garage'],
        ['Second Floor', 'Master Bedroom'],
        ['Second Floor', 'Master Bathroom'],
        ['Second Floor', 'Bedroom 1'],
        ['Second Floor', 'Bedroom 2'],
        ['Second Floor', 'Common Bathroom 2'],
      ].map(([floorName, name], index) => ({
        floorName,
        name,
        inspectionOrder: index + 1,
        isRequired: name !== 'Garage',
      })),
    );
  }
}

@Injectable()
export class MockVideoPlatformProvider implements VideoPlatformProvider {
  createUploadSession(idempotencyKey: string) {
    return {
      providerUploadId: `mock-upload-${idempotencyKey}`,
      uploadUrl: `mock://upload/${idempotencyKey}`,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
  }
}

@Injectable()
export class MockTranscriptionProvider implements TranscriptionProvider {
  transcribe() {
    return {
      language: 'en-US',
      confidence: 0.96,
      segments: [
        [0, 4, 'This is Bedroom 1.'],
        [5, 13, 'There are several deep scratches on the wall beside the closet.'],
        [14, 22, 'The carpet has a large dark stain near the window.'],
        [23, 30, 'The lower closet-door hinge is damaged.'],
        [31, 37, 'The window and ceiling appear to be in acceptable condition.'],
      ].map(([startSeconds, endSeconds, text]) => ({
        startSeconds: Number(startSeconds),
        endSeconds: Number(endSeconds),
        text: String(text),
        confidence: 0.96,
      })),
    };
  }
}

@Injectable()
export class MockAiAnalysisProvider implements AiAnalysisProvider {
  analyze(propertyAreaId: string, areaName: string) {
    const common = {
      propertyAreaId,
      areaName,
      baselineCondition:
        'Move-in baseline: walls, carpet, and closet door were in good condition; a small paint chip beside the light switch was documented.',
      possibleResponsibility: ResponsibilityClassification.TENANT_REVIEW_REQUIRED,
      confidence: 0.91,
      recommendedReview:
        'Compare against move-in evidence before making any responsibility or charge decision.',
    };
    return aiFindingListSchema.parse([
      {
        ...common,
        findingType: 'possible_new_damage',
        category: 'walls',
        title: 'Deep wall scratches',
        description: 'Several deep scratches were reported beside the closet.',
        comparisonResult: ComparisonResult.POSSIBLE_NEW_DAMAGE,
        videoTimestampStart: 5,
        videoTimestampEnd: 13,
        severity: Severity.MEDIUM,
      },
      {
        ...common,
        findingType: 'possible_new_damage',
        category: 'flooring',
        title: 'Large carpet stain',
        description: 'A large dark stain was shown near the bedroom window.',
        comparisonResult: ComparisonResult.POSSIBLE_NEW_DAMAGE,
        videoTimestampStart: 14,
        videoTimestampEnd: 22,
        severity: Severity.MEDIUM,
      },
      {
        ...common,
        findingType: 'possible_new_damage',
        category: 'doors',
        title: 'Damaged closet-door hinge',
        description: 'The lower closet-door hinge was reported damaged.',
        comparisonResult: ComparisonResult.POSSIBLE_NEW_DAMAGE,
        videoTimestampStart: 23,
        videoTimestampEnd: 30,
        severity: Severity.MEDIUM,
      },
    ]);
  }
}

@Injectable()
export class InMemoryJobQueueProvider implements JobQueueProvider {
  enqueue<T>(_name: string, job: () => T) {
    return job();
  }
}
@Injectable()
export class LocalDevelopmentFloorPlanStorageProvider implements FloorPlanStorageProvider {
  register(fileName: string) {
    return `local-development/${Date.now()}-${fileName}`;
  }
}

@Injectable()
export class MockWebhookSignatureVerifier implements WebhookSignatureVerifier {
  verify(rawBody: string, signature: string | undefined) {
    void rawBody;
    void signature;
    return process.env.NODE_ENV !== 'production';
  }
}

export class CloudflareStreamProvider {
  readonly configured = false;
}
export class AnthropicClaudeProvider {
  readonly configured = false;
}
export class SupabaseFloorPlanStorageProvider {
  readonly configured = false;
}
export class BullMqJobQueueProvider {
  readonly configured = false;
}
