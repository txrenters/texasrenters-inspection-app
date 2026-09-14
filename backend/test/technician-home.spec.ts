import { BadRequestException } from '@nestjs/common';

import { TechnicianHomeService } from '../src/technician/technician-home.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * A technician's home, which is where their route starts before they set off.
 *
 * Entered by the technician rather than inferred from where their phone sleeps,
 * and geocoded to a roof — an address that cannot be found precisely is refused
 * rather than stored as the middle of a city.
 */

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
} as AuthenticatedUser;

const dec = (value: number) => ({ toNumber: () => value });

function build(answer: unknown) {
  const prisma = {
    technicianPlanningProfile: {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const geocoding = { geocodeAddress: jest.fn().mockResolvedValue(answer) };
  return {
    service: new TechnicianHomeService(prisma as never, geocoding as never),
    prisma,
    geocoding,
  };
}

const ROOFTOP = {
  latitude: 30.0167,
  longitude: -95.6031,
  precision: 'ROOFTOP',
  matchedAddress: '12111 Westwold Dr, Tomball, TX 77377, USA',
  source: 'GOOGLE',
};

describe('setting a home', () => {
  it('stores the rooftop it was geocoded to', async () => {
    const { service, prisma } = build(ROOFTOP);

    await service.set(user, '12111 Westwold Dr, Tomball TX');

    const args = prisma.technicianPlanningProfile.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ technicianId: user.id });
    expect(args.create.homeLatitude).toBe(30.0167);
    expect(args.update.homeGeocodedFor).toBe('12111 Westwold Dr, Tomball TX');
  });

  it('reads back what Google matched, so a wrong suburb is caught now', async () => {
    const { service } = build(ROOFTOP);
    const result = await service.set(user, '12111 Westwold Dr');
    expect(result.home.matchedAddress).toContain('Tomball');
  });

  it('refuses an address it could only place as a city centre', async () => {
    /**
     * Stored, every route would begin in the middle of Houston and look
     * entirely plausible — the failure that once moved a property 7.2km into a
     * field, quietly skewing every morning's first drive instead.
     */
    const { service, prisma } = build({ ...ROOFTOP, precision: 'CENTROID' });

    await expect(service.set(user, 'somewhere in Houston')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.technicianPlanningProfile.upsert).not.toHaveBeenCalled();
  });

  it('refuses an address nothing can place at all', async () => {
    const { service, prisma } = build(null);
    await expect(service.set(user, 'not a real place 99999')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.technicianPlanningProfile.upsert).not.toHaveBeenCalled();
  });

  it('refuses an empty address before spending a geocode on it', async () => {
    const { service, geocoding } = build(ROOFTOP);
    await expect(service.set(user, '   ')).rejects.toBeInstanceOf(BadRequestException);
    expect(geocoding.geocodeAddress).not.toHaveBeenCalled();
  });

  it('tidies whitespace so the stored address is the one somebody meant', async () => {
    const { service, geocoding } = build(ROOFTOP);
    await service.set(user, '  12111   Westwold  Dr  ');
    expect(geocoding.geocodeAddress).toHaveBeenCalledWith('12111 Westwold Dr');
  });

  it('only ever writes the signed-in technician’s own row', async () => {
    const { service, prisma } = build(ROOFTOP);
    await service.set(user, '12111 Westwold Dr');
    const args = prisma.technicianPlanningProfile.upsert.mock.calls[0][0];
    expect(args.create.technicianId).toBe(user.id);
    expect(args.create.organizationId).toBe(user.organizationId);
  });
});

describe('reading and clearing a home', () => {
  it('reports none when there is none', async () => {
    const { service } = build(ROOFTOP);
    expect(await service.get(user)).toEqual({ home: null });
  });

  it('returns numbers, not decimals', async () => {
    const { service, prisma } = build(ROOFTOP);
    prisma.technicianPlanningProfile.findUnique.mockResolvedValue({
      homeGeocodedFor: '12111 Westwold Dr',
      homeLatitude: dec(30.0167),
      homeLongitude: dec(-95.6031),
    });
    const { home } = await service.get(user);
    expect(home?.latitude).toBe(30.0167);
    expect(typeof home?.longitude).toBe('number');
  });

  it('clears the home without deleting the rest of the profile', async () => {
    // The profile also carries a daily stop cap somebody may have set.
    const { service, prisma } = build(ROOFTOP);
    await service.clear(user);
    expect(prisma.technicianPlanningProfile.updateMany).toHaveBeenCalledWith({
      where: { technicianId: user.id },
      data: { homeLatitude: null, homeLongitude: null, homeGeocodedFor: null },
    });
  });
});
