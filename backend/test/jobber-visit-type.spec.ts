import { InspectionType } from '@prisma/client';

import {
  DEFAULT_VISIT_TYPE_RULES,
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
