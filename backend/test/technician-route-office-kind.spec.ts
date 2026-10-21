import { TechnicianController } from '../src/technician/technician.controller';

/**
 * The phone's own route, from the office.
 *
 * Every app built before 2026-10-22 parses the route's `originKind` against the
 * kinds it names and refuses the whole route over any other -- the suggested
 * order vanished the same way once before (#220). So a route from the office
 * reaches the phones as `HOME`, and every other kind as it is.
 */

const request = { user: { organizationId: 'org-1', id: 'tech-1' } } as never;

const controllerReturning = (originKind: string) => {
  const routes = {
    planDay: jest.fn().mockResolvedValue({ technicianId: 'tech-1', originKind, stops: [] }),
  };
  const controller = new TechnicianController(
    {} as never,
    {} as never,
    {} as never,
    routes as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return controller;
};

describe('the technician’s route, as a phone reads it', () => {
  it('calls the office HOME, which every installed phone knows', async () => {
    const route = await controllerReturning('OFFICE').technicianRoute(request);

    expect(route.originKind).toBe('HOME');
    expect(route.stops).toEqual([]);
  });

  it('passes a live or last-known start through as it is', async () => {
    expect((await controllerReturning('LIVE').technicianRoute(request)).originKind).toBe('LIVE');
    expect((await controllerReturning('LAST_KNOWN').technicianRoute(request)).originKind).toBe('LAST_KNOWN');
  });
});
