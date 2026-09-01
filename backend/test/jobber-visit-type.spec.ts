import { InspectionType } from '@prisma/client';

import {
  DEFAULT_VISIT_TYPE_RULES,
  allowsTechnicianCapture,
  resolveVisitType,
  visitTypeRules,
} from '../src/integrations/jobber/jobber.visit-type';

describe('Jobber visit type resolution', () => {
  it('types a visit from its title', () => {
    expect(resolveVisitType('Move In Inspection — 1200 Oak St')).toEqual({
      outcome: 'RESOLVED',
      inspectionType: InspectionType.MOVE_IN,
    });
    expect(resolveVisitType('HVAC service')).toEqual({
      outcome: 'RESOLVED',
      inspectionType: InspectionType.HVAC,
    });
  });

  it('tolerates the ways the office writes the same thing', () => {
    for (const title of ['Move-Out', 'move out', 'MOVEOUT walkthrough'])
      expect(resolveVisitType(title)).toEqual({
        outcome: 'RESOLVED',
        inspectionType: InspectionType.MOVE_OUT,
      });
  });

  it("types this office's real filter-delivery titles", () => {
    // Both forms appear verbatim in their Jobber calendar; the first accounted
    // for nearly half of every visit on the first live sync.
    for (const title of [
      '16918 Wedgeside Park - Zone 1 - Q3 2026 Tenant Benefit Package',
      '10414 Hondo Hill Rd - Zone 2 - Q3 TBP Filter Change + Pest Control',
    ])
      expect(resolveVisitType(title)).toEqual({
        outcome: 'RESOLVED',
        inspectionType: InspectionType.AC_FILTER_DELIVERY,
      });
  });

  it('still refuses the maintenance work that shares their title format', () => {
    // These are real titles too, and none of them is an inspection.
    for (const title of [
      '1526A Creekside Ln - 1526A - Zone 5 - Door - #43929',
      '3113A Everwood Trl - Zone 5 - General Maintenance - #43866',
      '11203 Doric Ct - Zone 2 - Home Cleaning',
      '4207 Hardy St - Zone 2 - Drywall Repair',
    ])
      expect(resolveVisitType(title).outcome).toBe('UNKNOWN');
  });

  it('refuses a title that names two kinds of visit', () => {
    // "Move out and lockbox removal" is genuinely two jobs. Picking either
    // would scope the inspection to the wrong areas.
    const resolution = resolveVisitType('Move out and lockbox removal');
    expect(resolution.outcome).toBe('AMBIGUOUS');
    expect(resolution).toMatchObject({
      matches: expect.arrayContaining([
        InspectionType.MOVE_OUT,
        InspectionType.SUPRA_LOCKBOX_REMOVAL,
      ]),
    });
  });

  it('refuses rather than guessing when nothing matches', () => {
    expect(resolveVisitType('Quarterly landscaping')).toEqual({ outcome: 'UNKNOWN' });
    expect(resolveVisitType('')).toEqual({ outcome: 'UNKNOWN' });
    expect(resolveVisitType(null)).toEqual({ outcome: 'UNKNOWN' });
  });

  it('lets the office override the keywords without a deploy', () => {
    const rules = visitTypeRules({
      JOBBER_VISIT_TYPE_RULES: JSON.stringify({ OCCUPIED: ['annual check'] }),
    } as NodeJS.ProcessEnv);
    expect(resolveVisitType('Annual Check', rules)).toEqual({
      outcome: 'RESOLVED',
      inspectionType: InspectionType.OCCUPIED,
    });
    // Overriding one type leaves the rest alone.
    expect(resolveVisitType('Move in', rules)).toEqual({
      outcome: 'RESOLVED',
      inspectionType: InspectionType.MOVE_IN,
    });
  });

  it('keeps the working rules when the override is malformed', () => {
    // The sync refusing to start is worse than it running with the rules that
    // were already working; an unknown title is refused per visit anyway.
    for (const raw of ['not json', '{"MOVE_IN": "not an array"}', '{"NOT_A_TYPE": ["x"]}'])
      expect(visitTypeRules({ JOBBER_VISIT_TYPE_RULES: raw } as NodeJS.ProcessEnv)[
        InspectionType.MOVE_IN
      ]).toEqual(DEFAULT_VISIT_TYPE_RULES[InspectionType.MOVE_IN]);
  });

  it('covers every inspection type, so a new one cannot be silently untypeable', () => {
    for (const type of Object.values(InspectionType))
      expect(DEFAULT_VISIT_TYPE_RULES[type]?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('technician area capture policy', () => {
  it('lets a filter delivery survey a property nobody has drawn yet', () => {
    // Without this every one of these is refused for a missing layout, which is
    // currently every property in the portfolio.
    expect(allowsTechnicianCapture(InspectionType.AC_FILTER_DELIVERY)).toBe(true);
  });

  it('never lets the tenancy lifecycle establish its own baseline', () => {
    // A move-in defines what every later inspection is compared against, and a
    // move-out is read against it area by area. An unreviewed on-site list must
    // not become that reference.
    for (const type of [
      InspectionType.MOVE_IN,
      InspectionType.MOVE_OUT,
      InspectionType.OCCUPIED,
      InspectionType.BACK_TO_MARKET,
    ])
      expect(allowsTechnicianCapture(type)).toBe(false);
  });

  it('leaves every other type opted out, so a new one is not silently included', () => {
    const allowed = Object.values(InspectionType).filter(allowsTechnicianCapture);
    expect(allowed).toEqual([InspectionType.AC_FILTER_DELIVERY]);
  });
});
