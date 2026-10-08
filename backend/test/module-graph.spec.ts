import { Test } from '@nestjs/testing';

import { AdminModule } from '../src/admin/admin.module';
import { ComparisonReportService } from '../src/admin/comparison-report.service';
import { ComparisonService } from '../src/admin/comparison.service';
import { ReportShareService } from '../src/admin/report-share.service';
import { AdminController } from '../src/admin/admin.controller';
import { AiProviderSettingsService } from '../src/admin/ai-provider-settings.service';
import { ChecklistPrefillService } from '../src/technician/checklist-prefill.service';
import { MediaProcessingService } from '../src/technician/media-processing.service';
import { RecordingSummaryService } from '../src/technician/recording-summary.service';
import { CacheInvalidationService } from '../src/cache/cache-invalidation.service';
import { CacheModule } from '../src/cache/cache.module';
import { PrismaService } from '../src/common/prisma.service';
import { DatabaseModule } from '../src/database/database.module';
import { JobberModule } from '../src/integrations/jobber/jobber.module';
import { InspectionVideoService } from '../src/media/inspection-video.service';
import { MediaModule } from '../src/media/media.module';
import { LeaseInspectionService } from '../src/planning/lease-inspections.service';
import { PlanningModule } from '../src/planning/planning.module';
import { TbpPublishService } from '../src/planning/tbp-publish.service';
import { TbpStopEditService } from '../src/planning/tbp-stop-edit.service';
import { TechnicianEventsGateway } from '../src/realtime/technician-events.gateway';
import { JobberSyncWorker } from '../src/workers/jobber-sync/jobber-sync.worker';

/**
 * The wiring, which no other test here touches.
 *
 * Every other suite builds a service with `new`, handing it whatever it needs.
 * That proves the code and says nothing about the module graph -- so on
 * 2026-09-20 a service that injected `AiProviderSettingsService` without
 * `AdminModule` exporting it passed the whole suite, and then the backend threw
 * at boot. Three releases deployed, failed their health check and were rolled
 * back before anybody looked at the container rather than at CI.
 *
 * Compiling the module is what catches it: Nest resolves every provider here,
 * and an unreachable one fails this test instead of production.
 */
describe('the planning module', () => {
  it('resolves every dependency its services ask for', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PlanningModule] })
      // The only thing that would reach outside the process on construction.
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(TbpStopEditService)).toBeInstanceOf(TbpStopEditService);
    expect(moduleRef.get(TbpPublishService)).toBeInstanceOf(TbpPublishService);
    // A lease call-off tells the technician whose job it was (2026-10-07).
    const lease = moduleRef.get(LeaseInspectionService) as unknown as { technicianEvents?: unknown };
    expect(lease.technicianEvents).toBeInstanceOf(TechnicianEventsGateway);
  });
});

/**
 * The media module's frame capture, which files a still from a recording as a
 * photograph ("Add photo", and accepting the AI's suggested frame).
 *
 * It asks for the photo storage as an optional dependency, so a module graph
 * that cannot reach it does not fail at boot -- it hands the service nothing,
 * and on 2026-10-03 every capture in production answered "Photo storage is not
 * configured" with storage configured all along. Optional dependencies are the
 * ones only this kind of test can see.
 */
describe('the media module', () => {
  it('gives frame capture the photo storage', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MediaModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    const service = moduleRef.get(InspectionVideoService);

    // Storage is checked before permission: a caller without the permission is
    // refused for that, not told storage is missing.
    await expect(
      service.captureSnapshot(
        { id: 'user-1', organizationId: 'org-1', permissions: [] } as never,
        'video-1',
        { atMs: 1000 },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

/**
 * The Jobber sync, which removes an inspection whose visit Jobber deleted and
 * tells its technician (2026-10-07). The gateway and the console's cache
 * refresh are optional dependencies, so only this kind of test sees one go
 * missing -- and a missing gateway would remove jobs from the console without
 * a word to the phone that is driving to them.
 */
describe('the Jobber module', () => {
  it('gives the sync the technician events and the cache refresh', async () => {
    // The global modules the app provides it with; the database is faked below.
    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule, CacheModule, JobberModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    const worker = moduleRef.get(JobberSyncWorker) as unknown as {
      technicianEvents?: unknown;
      cacheInvalidation?: unknown;
    };

    expect(worker.technicianEvents).toBeInstanceOf(TechnicianEventsGateway);
    expect(worker.cacheInvalidation).toBeInstanceOf(CacheInvalidationService);
  });
});

/**
 * Report links, which issue and serve the move-in / move-out comparison too
 * (2026-10-06). The comparison services are optional dependencies of the share
 * service, so only this kind of test sees one go missing.
 */
describe('the admin module', () => {
  it('gives report links the comparison services', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AdminModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    const service = moduleRef.get(ReportShareService) as unknown as {
      comparisonReport?: unknown;
      comparisons?: unknown;
    };

    expect(service.comparisonReport).toBeInstanceOf(ComparisonReportService);
    expect(service.comparisons).toBeInstanceOf(ComparisonService);
  });
});

/**
 * The checklist filled from the narration (2026-10-07). Optional in both the
 * console's controller and the pipeline, so a graph that cannot reach it would
 * boot fine and answer "not available" -- or never fill anything on review.
 */
describe('the narration pre-fill', () => {
  it('reaches the console and the pipeline', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AdminModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    const controller = moduleRef.get(AdminController) as unknown as {
      checklistPrefill?: unknown;
      recordingSummary?: unknown;
    };
    const pipeline = moduleRef.get(MediaProcessingService) as unknown as {
      checklistPrefill?: unknown;
      recordingSummary?: unknown;
    };

    expect(controller.checklistPrefill).toBeInstanceOf(ChecklistPrefillService);
    expect(pipeline.checklistPrefill).toBeInstanceOf(ChecklistPrefillService);
    // And the report's summary of each room's recordings (2026-10-07).
    expect(controller.recordingSummary).toBeInstanceOf(RecordingSummaryService);
    expect(pipeline.recordingSummary).toBeInstanceOf(RecordingSummaryService);
    // And the comparison's AI room pairing (2026-10-08), in both modules that
    // provide the comparison: optional, so only this test sees it go missing.
    const comparisons = moduleRef.get(ComparisonService) as unknown as { aiSettings?: unknown };
    expect(comparisons.aiSettings).toBeInstanceOf(AiProviderSettingsService);
    const pipelineComparison = (pipeline as unknown as { comparison?: { aiSettings?: unknown } }).comparison;
    expect(pipelineComparison?.aiSettings).toBeInstanceOf(AiProviderSettingsService);
  });
});
