import { Test } from '@nestjs/testing';

import { PrismaService } from '../src/common/prisma.service';
import { InspectionVideoService } from '../src/media/inspection-video.service';
import { MediaModule } from '../src/media/media.module';
import { PlanningModule } from '../src/planning/planning.module';
import { TbpPublishService } from '../src/planning/tbp-publish.service';
import { TbpStopEditService } from '../src/planning/tbp-stop-edit.service';

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
