import { Test } from '@nestjs/testing';

import { PrismaService } from '../src/common/prisma.service';
import { PlanAdvisorService } from '../src/planning/plan-advisor.service';
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

    expect(moduleRef.get(PlanAdvisorService)).toBeInstanceOf(PlanAdvisorService);
    expect(moduleRef.get(TbpStopEditService)).toBeInstanceOf(TbpStopEditService);
    expect(moduleRef.get(TbpPublishService)).toBeInstanceOf(TbpPublishService);
  });
});
