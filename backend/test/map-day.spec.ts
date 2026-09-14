import { businessDayFromQuery } from '../src/common/business-day';
import { RouteService } from '../src/routing/route.service';

/**
 * The day the map asks for is the day it gets, from both endpoints.
 *
 * The map sends `?date=2026-09-14` twice: once for who is working, once for
 * each person's route. The two must bound the same Texas day. If they do not,
 * the map hides somebody whose route has stops, or draws a route for somebody
 * it hid -- and `@db.Date` stops and timestamped positions are compared against
 * the same bounds, so the positions have to be that day's too.
 */

describe('the day a map date asks for', () => {
  function capturing() {
    const seen: { stops: unknown[]; positions: unknown[] } = { stops: [], positions: [] };
    const prisma = {
      inspectionAssignment: {
        findMany: async (args: { where: { inspection: { scheduledAt: unknown } } }) => {
          seen.stops.push(args.where.inspection.scheduledAt);
          return [];
        },
      },
      technicianLocationPing: {
        findFirst: async (args: { where: { recordedAt: unknown } }) => {
          seen.positions.push(args.where.recordedAt);
          return null;
        },
      },
      technicianPlanningProfile: { findFirst: async () => null },
    };
    const service = new RouteService(prisma as never, {} as never, {} as never);
    return { service, seen };
  }

  it('is the Texas day of that date, for the list and the route alike', async () => {
    const { service, seen } = capturing();
    const day = businessDayFromQuery('2026-09-14');

    await service.assignmentsByTechnician('org', day);
    await service.planDay('org', 'tech', day);

    // September is CDT, so the 14th in Texas runs 05:00 to 05:00 UTC.
    const fourteenth = {
      gte: new Date('2026-09-14T05:00:00.000Z'),
      lt: new Date('2026-09-15T05:00:00.000Z'),
    };
    expect(seen.stops).toEqual([fourteenth, fourteenth]);
    expect(seen.positions).toEqual([fourteenth]);
  });
});
