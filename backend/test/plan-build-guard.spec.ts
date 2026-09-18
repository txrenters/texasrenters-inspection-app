import { LONG_REQUEST_TIMEOUT_MS } from '../src/common/long-request';
import { PlanBuildGuard } from '../src/planning/plan-build-guard';
import { PlanningController } from '../src/planning/planning.controller';
import { TbpPlanScheduler } from '../src/planning/tbp-plan.scheduler';

const ORGANIZATION_ID = 'org-1';

/** A promise the test settles when it chooses, to keep a build running. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const request = () => ({ user: { organizationId: ORGANIZATION_ID }, setTimeout: jest.fn() });

function controllerWith(
  guard: PlanBuildGuard,
  services: { plans?: object; planner?: object; publisher?: object; prisma?: object } = {},
) {
  return new PlanningController(
    (services.prisma ?? {}) as never,
    (services.plans ?? {}) as never,
    (services.planner ?? {}) as never,
    (services.publisher ?? {}) as never,
    {} as never,
    {} as never,
    {} as never,
    guard,
  );
}

/**
 * 2026-09-16: a Rebuild takes minutes, the server dropped the console's request
 * at 30 seconds, and a second click built the same plan again over the first.
 */
describe('one build of a plan at a time', () => {
  it('refuses a second build while the first runs, naming the quarter and since when', async () => {
    const guard = new PlanBuildGuard();
    const first = held<string>();
    const running = guard.run(ORGANIZATION_ID, 'Q4 2026', () => first.promise);

    const refused = guard.run(ORGANIZATION_ID, 'Q4 2026', async () => 'second');
    await expect(refused).rejects.toMatchObject({ code: 'PLAN_BUILD_RUNNING' });
    await expect(refused).rejects.toThrow(/^The Q4 2026 plan is already being built, since \d{1,2}:\d{2} [AP]M Central\. /);
    await refused.catch((error: { getStatus(): number }) => expect(error.getStatus()).toBe(409));

    first.resolve('first');
    await expect(running).resolves.toBe('first');
    await expect(guard.run(ORGANIZATION_ID, 'Q4 2026', async () => 'next')).resolves.toBe('next');
  });

  it('lets the next build start after one fails', async () => {
    const guard = new PlanBuildGuard();

    await expect(
      guard.run(ORGANIZATION_ID, 'Q4 2026', async () => {
        throw new Error('Google answered nothing');
      }),
    ).rejects.toThrow('Google answered nothing');

    expect(guard.current(ORGANIZATION_ID)).toBeNull();
    await expect(guard.run(ORGANIZATION_ID, 'Q4 2026', async () => 'next')).resolves.toBe('next');
  });

  it('never holds one organization up for another', async () => {
    const guard = new PlanBuildGuard();
    const first = held<string>();
    const running = guard.run(ORGANIZATION_ID, 'Q4 2026', () => first.promise);

    await expect(guard.run('org-2', 'Q4 2026', async () => 'other')).resolves.toBe('other');

    first.resolve('first');
    await running;
  });
});

describe('building from the console', () => {
  const quarter = { year: 2026, quarter: 4 };
  /** What routing answers, with the settings the plan was laid out with. */
  const routed = (settings: Record<string, unknown> = {}) => ({
    quarter,
    placed: 3,
    days: 1,
    unplaced: [],
    settings: { technicianIds: [], startsOn: null, maxLegMinutes: 20, ...settings },
  });
  const audited = () => ({ auditLog: { create: jest.fn().mockResolvedValue({}) } });

  it('holds the request open past the server’s 30-second idle timeout', async () => {
    const plans = { generate: jest.fn().mockResolvedValue({ planId: 'plan-1', stopCount: 3 }) };
    const planner = { route: jest.fn().mockResolvedValue(routed()) };
    const controller = controllerWith(new PlanBuildGuard(), { plans, planner, prisma: audited() });
    const incoming = request();

    await expect(controller.generate(incoming as never, quarter as never)).resolves.toMatchObject({
      planId: 'plan-1',
      routing: { placed: 3, days: 1 },
    });

    expect(incoming.setTimeout).toHaveBeenCalledWith(LONG_REQUEST_TIMEOUT_MS);
    expect(LONG_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000);
    // Never a day already gone: today, in Texas, goes with the build.
    expect(planner.route).toHaveBeenCalledWith(ORGANIZATION_ID, 'plan-1', {}, { today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  /** The office (2026-09-19): who goes out on a quarter is the coordinator's choice, so it is on the record. */
  it('records who a build sends out and from which day', async () => {
    const plans = { generate: jest.fn().mockResolvedValue({ planId: 'plan-1', stopCount: 3 }) };
    const planner = { route: jest.fn().mockResolvedValue(routed({ technicianIds: ['tech-1', 'tech-2'], startsOn: '2026-09-21' })) };
    const prisma = audited();
    const controller = controllerWith(new PlanBuildGuard(), { plans, planner, prisma });

    await controller.generate(request() as never, { ...quarter, technicianIds: ['tech-1', 'tech-2'], startsOn: '2026-09-21' } as never);

    expect(planner.route).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      'plan-1',
      { technicianIds: ['tech-1', 'tech-2'], startsOn: '2026-09-21' },
      expect.anything(),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        action: 'TBP_PLAN_BUILT',
        entityType: 'TbpQuarterPlan',
        entityId: 'plan-1',
        metadata: expect.objectContaining({ quarter: 'Q4 2026', technicianIds: ['tech-1', 'tech-2'], startsOn: '2026-09-21' }),
      }),
    });
  });

  it('refuses Rebuild clicked again while the first build is still running', async () => {
    const generation = held<{ planId: string }>();
    const plans = { generate: jest.fn(() => generation.promise) };
    const planner = { route: jest.fn().mockResolvedValue(routed()) };
    const controller = controllerWith(new PlanBuildGuard(), { plans, planner, prisma: audited() });

    const first = controller.generate(request() as never, quarter as never);
    await expect(controller.generate(request() as never, quarter as never)).rejects.toMatchObject({
      code: 'PLAN_BUILD_RUNNING',
    });
    expect(plans.generate).toHaveBeenCalledTimes(1);

    generation.resolve({ planId: 'plan-1' });
    await expect(first).resolves.toMatchObject({ planId: 'plan-1' });
  });

  it('refuses to lay the days out again while a build runs', async () => {
    const guard = new PlanBuildGuard();
    const build = held<void>();
    const running = guard.run(ORGANIZATION_ID, 'Q4 2026', () => build.promise);
    const planner = { route: jest.fn() };
    const prisma = { tbpQuarterPlan: { findFirst: jest.fn().mockResolvedValue({ quarterYear: 2026, quarterNumber: 4 }) } };
    const controller = controllerWith(guard, { planner, prisma });

    await expect(controller.route(request() as never, 'plan-1', {} as never)).rejects.toMatchObject({
      code: 'PLAN_BUILD_RUNNING',
    });
    expect(planner.route).not.toHaveBeenCalled();

    build.resolve();
    await running;
  });

  it('never publishes a plan while it is being built, and holds a publish open too', async () => {
    const guard = new PlanBuildGuard();
    const build = held<void>();
    const running = guard.run(ORGANIZATION_ID, 'Q4 2026', () => build.promise);
    const publisher = { publish: jest.fn().mockResolvedValue({ published: 3, adopted: 0, failed: 0 }) };
    const controller = controllerWith(guard, { publisher });

    expect(() => controller.publish(request() as never, 'plan-1')).toThrow(
      expect.objectContaining({ code: 'PLAN_BUILD_RUNNING' }),
    );
    expect(publisher.publish).not.toHaveBeenCalled();

    build.resolve();
    await running;
    const incoming = request();
    await controller.publish(incoming as never, 'plan-1');
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(incoming.setTimeout).toHaveBeenCalledWith(LONG_REQUEST_TIMEOUT_MS);
  });
});

describe('the daily planning tick', () => {
  afterEach(() => jest.useRealTimers());

  it('skips a day rather than building over a build from the console', async () => {
    // Inside Q1 2027's planning window, so the tick would otherwise build it.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date('2026-12-24T12:00:00Z'));
    const guard = new PlanBuildGuard();
    const build = held<void>();
    const running = guard.run(ORGANIZATION_ID, 'Q4 2026', () => build.promise);
    const plans = { generate: jest.fn() };
    const scheduler = new TbpPlanScheduler(plans as never, {} as never, guard);

    await (scheduler as unknown as { tick(organizationId: string): Promise<void> }).tick(ORGANIZATION_ID);

    expect(plans.generate).not.toHaveBeenCalled();
    build.resolve();
    await running;
  });
});
