import type { AssignedStop } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { actualDayTotals, actualVisits } from './route-plan';

/**
 * A technician's day as the inspections recorded it.
 *
 * The office asked for the actual time of each visit -- Start in the app to
 * Submit -- and the actual drive between them, instead of the location trail's
 * estimate, which went quiet on 14 September and called ten visits "1 min
 * driving".
 */

const stop = (id: string, over: Partial<AssignedStop>): AssignedStop => ({
  inspectionId: id,
  buildingId: `building-${id}`,
  propertyName: `Property ${id}`,
  inspectionType: 'OCCUPIED',
  status: 'TECHNICIAN_SUBMITTED',
  finishedAt: null,
  ...over,
});

// Times in UTC; 14:00Z is 9:00 AM in Houston in September.
const oak = stop('oak', { propertyName: '4226 Oak Shadows', startedAt: '2026-09-14T14:55:00Z', submittedAt: '2026-09-14T15:24:00Z' });
const chamboard = stop('chamboard', { propertyName: '1150 chamboard', startedAt: '2026-09-14T15:32:00Z', submittedAt: '2026-09-14T15:42:00Z' });

describe('the actual time of each visit', () => {
  it('is Start to Submit on site, and the drive from the previous submission', () => {
    const visits = actualVisits([chamboard, oak]);

    expect(visits.get('oak')).toMatchObject({ onSiteSeconds: 29 * 60, driveSeconds: null, inProgress: false });
    expect(visits.get('chamboard')).toEqual({
      startedAt: '2026-09-14T15:32:00Z',
      submittedAt: '2026-09-14T15:42:00Z',
      onSiteSeconds: 10 * 60,
      inProgress: false,
      // Submitted Oak Shadows at 15:24, started chamboard at 15:32.
      driveSeconds: 8 * 60,
      fromPropertyName: '4226 Oak Shadows',
    });
  });

  it('counts no drive between two inspections at the same property', () => {
    const tbp = stop('tbp', {
      buildingId: 'building-oak',
      startedAt: '2026-09-14T15:26:00Z',
      submittedAt: '2026-09-14T15:30:00Z',
    });
    const visits = actualVisits([oak, stop('oak', { ...oak, buildingId: 'building-oak' }), tbp]);
    expect(visits.get('tbp')?.driveSeconds).toBeNull();
  });

  it('counts no drive into a visit started before the previous one was submitted', () => {
    const early = stop('early', { startedAt: '2026-09-14T15:20:00Z', submittedAt: '2026-09-14T15:50:00Z' });
    expect(actualVisits([oak, early]).get('early')?.driveSeconds).toBeNull();
  });

  it('measures a visit still under way up to now', () => {
    const underway = stop('now', { status: 'IN_PROGRESS', startedAt: '2026-09-14T16:00:00Z', submittedAt: null });
    const visit = actualVisits([oak, chamboard, underway], Date.parse('2026-09-14T16:12:00Z')).get('now');
    expect(visit).toMatchObject({ inProgress: true, onSiteSeconds: 12 * 60, driveSeconds: 18 * 60 });
  });

  it('leaves out an inspection never started in the app', () => {
    // Closed in Jobber: there is no visit to time, and inventing one would be worse.
    expect(actualVisits([stop('jobber', { startedAt: null, submittedAt: null })]).size).toBe(0);
  });
});

describe('the day added up', () => {
  it('adds on site and driving across the visits', () => {
    expect(actualDayTotals(actualVisits([oak, chamboard]))).toEqual({
      visits: 2,
      submitted: 2,
      onSiteSeconds: 39 * 60,
      driveSeconds: 8 * 60,
      totalSeconds: 47 * 60,
    });
  });

  it('is absent when nothing was started in the app, so the trail can stand in', () => {
    expect(actualDayTotals(actualVisits([stop('jobber', {})]))).toBeNull();
  });
});
