import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { PropertyGeocodingService } from '../admin/property-geocoding.service';

/**
 * Where a technician's day starts, entered by the technician.
 *
 * A route drawn before anybody has set off has to begin somewhere, and the
 * previous answer -- the newest position, however old -- began Monday from
 * wherever a phone happened to be at four on Saturday morning.
 *
 * Entered rather than inferred. Deriving somebody's home from where their phone
 * spends the night is exactly the tracking the location feature refuses to do
 * outside working hours, and it would be wrong for anybody who starts from
 * somewhere else.
 */
@Injectable()
export class TechnicianHomeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PropertyGeocodingService) private readonly geocoding: PropertyGeocodingService,
  ) {}

  async get(user: AuthenticatedUser) {
    const profile = await this.prisma.technicianPlanningProfile.findUnique({
      where: { technicianId: user.id },
      select: { homeGeocodedFor: true, homeLatitude: true, homeLongitude: true },
    });
    if (!profile?.homeLatitude || !profile.homeLongitude) return { home: null };
    return {
      home: {
        address: profile.homeGeocodedFor,
        latitude: profile.homeLatitude.toNumber(),
        longitude: profile.homeLongitude.toNumber(),
      },
    };
  }

  async set(user: AuthenticatedUser, rawAddress: string) {
    const address = rawAddress.trim().replace(/\s+/g, ' ');
    if (!address) throw new BadRequestException('Enter an address.');

    const answer = await this.geocoding.geocodeAddress(address);

    /**
     * Refused rather than stored approximately.
     *
     * An address Google cannot find comes back as the centre of the city or the
     * postcode -- a `CENTROID`. Stored as a home, every route would begin in
     * the middle of Houston and look entirely plausible. This is the same
     * failure that once moved a property 7.2km into a field; here it would
     * quietly skew every morning's first drive instead. Telling the technician
     * is the only fix, because only they know what they meant.
     */
    if (!answer || answer.precision === 'CENTROID')
      throw new BadRequestException(
        'That address could not be found precisely. Check the street number and postcode.',
      );

    await this.prisma.technicianPlanningProfile.upsert({
      where: { technicianId: user.id },
      create: {
        organizationId: user.organizationId,
        technicianId: user.id,
        homeLatitude: answer.latitude,
        homeLongitude: answer.longitude,
        homeGeocodedFor: address,
      },
      update: {
        homeLatitude: answer.latitude,
        homeLongitude: answer.longitude,
        homeGeocodedFor: address,
      },
    });

    return {
      home: {
        address,
        // What Google matched, so the technician can see it understood them --
        // "12111 Westwold Dr, Tomball" read back is how a wrong suburb gets
        // caught at the moment it is entered rather than on Monday's route.
        matchedAddress: answer.matchedAddress,
        latitude: answer.latitude,
        longitude: answer.longitude,
        precision: answer.precision,
      },
    };
  }

  async clear(user: AuthenticatedUser) {
    // Kept as a row: the planning profile carries more than a home, and
    // deleting it would discard a daily stop cap somebody set on purpose.
    await this.prisma.technicianPlanningProfile.updateMany({
      where: { technicianId: user.id },
      data: { homeLatitude: null, homeLongitude: null, homeGeocodedFor: null },
    });
    return { home: null };
  }
}
