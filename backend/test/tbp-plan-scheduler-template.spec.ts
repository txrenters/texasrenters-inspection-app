import { PlanBuildGuard } from '../src/planning/plan-build-guard';
import { TbpPlanScheduler } from '../src/planning/tbp-plan.scheduler';

/**
 * The daily planner and the office's active group template (2026-09-30): a
 * quarter it creates is laid out from the template; a quarter already built
 * keeps the grouping it was built with.
 */

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const TEMPLATE_ID = '6f0c1d2e-0000-4000-8000-000000000001';

const tick = (scheduler: TbpPlanScheduler) =>
  (scheduler as unknown as { tick(organizationId: string): Promise<void> }).tick(ORGANIZATION_ID);

const setUp = (regenerated: boolean) => {
  const plans = {
    generate: jest.fn().mockResolvedValue({ planId: 'plan-1', blockedCount: 0, regenerated }),
  };
  const planner = {
    activeGroupTemplateId: jest.fn().mockResolvedValue(TEMPLATE_ID),
    route: jest.fn().mockResolvedValue({ unplaced: [], template: { id: TEMPLATE_ID, days: 40, notInTemplate: 3 } }),
  };
  return { plans, planner, scheduler: new TbpPlanScheduler(plans as never, planner as never, new PlanBuildGuard()) };
};

describe('the daily planner and the active group template', () => {
  beforeEach(() => {
    // Inside Q1 2027's planning window, so the tick builds it.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date('2026-12-24T12:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('lays a quarter it creates out from the active template', async () => {
    const { planner, scheduler } = setUp(false);

    await tick(scheduler);

    expect(planner.activeGroupTemplateId).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(planner.route.mock.calls[0][2]).toEqual({ groupTemplateId: TEMPLATE_ID });
  });

  it('leaves a quarter already built with the grouping the plan holds', async () => {
    const { planner, scheduler } = setUp(true);

    await tick(scheduler);

    expect(planner.activeGroupTemplateId).not.toHaveBeenCalled();
    expect(planner.route.mock.calls[0][2]).toEqual({});
  });

  it('builds with the planner’s own grouping when no template is active', async () => {
    const { planner, scheduler } = setUp(false);
    planner.activeGroupTemplateId.mockResolvedValue(null);

    await tick(scheduler);

    expect(planner.route.mock.calls[0][2]).toEqual({});
  });
});
