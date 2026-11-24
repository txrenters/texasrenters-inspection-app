import {
  pickedReason,
  rankWorkOrderTechnicians,
  type MatchGrant,
  type MatchTechnician,
} from '../src/work-orders/technician-matching';

/** The office's rule for who a work order goes to. People and skills invented. */

const plumbing = { id: 'skill-plumbing', label: 'Plumbing' };
const heater = { id: 'skill-heater', label: 'Water heater' };

const ana: MatchTechnician = { id: 'tech-ana', displayName: 'Ana', load: 0 };
const ben: MatchTechnician = { id: 'tech-ben', displayName: 'Ben', load: 0 };
const cal: MatchTechnician = { id: 'tech-cal', displayName: 'Cal', load: 0 };

const grant = (
  technician: MatchTechnician,
  skill: { id: string },
  level: MatchGrant['level'],
  note: string | null = null,
): MatchGrant => ({ technicianId: technician.id, skillId: skill.id, level, note });

describe('rankWorkOrderTechnicians', () => {
  it('never sends someone marked N', () => {
    const result = rankWorkOrderTechnicians({
      skills: [plumbing],
      scope: 'MINOR',
      technicians: [ana, ben],
      grants: [grant(ben, plumbing, 'FULL')],
    });
    expect(result.picked?.technicianId).toBe(ben.id);
    expect(result.ranking.find((r) => r.technicianId === ana.id)?.excludedBecause).toBe(
      'not marked for Plumbing',
    );
  });

  it('needs every skill the job asks for', () => {
    const result = rankWorkOrderTechnicians({
      skills: [plumbing, heater],
      scope: 'MINOR',
      technicians: [ana, ben],
      grants: [grant(ana, plumbing, 'FULL'), grant(ben, plumbing, 'LIMITED'), grant(ben, heater, 'LIMITED')],
    });
    expect(result.picked?.technicianId).toBe(ben.id);
  });

  it('prefers a plain Y, then a limit, then needs-improvement', () => {
    const result = rankWorkOrderTechnicians({
      skills: [plumbing],
      scope: 'MINOR',
      technicians: [ana, ben, cal],
      grants: [
        grant(ana, plumbing, 'NEEDS_IMPROVEMENT'),
        grant(ben, plumbing, 'LIMITED'),
        grant(cal, plumbing, 'FULL'),
      ],
    });
    expect(result.ranking.map((r) => [r.displayName, r.tier])).toEqual([
      ['Cal', 1],
      ['Ben', 2],
      ['Ana', 3],
    ]);
  });

  it('puts minor-repairs-only ahead of needs-improvement', () => {
    const result = rankWorkOrderTechnicians({
      skills: [plumbing],
      scope: 'MINOR',
      technicians: [ana, ben],
      grants: [grant(ana, plumbing, 'NEEDS_IMPROVEMENT'), grant(ben, plumbing, 'LIMITED', 'MINOR REPAIRS ONLY')],
    });
    expect(result.picked?.technicianId).toBe(ben.id);
  });

  it('sends needs-improvement when nobody else holds the skill at all', () => {
    const result = rankWorkOrderTechnicians({
      skills: [plumbing],
      scope: 'MAJOR',
      technicians: [ana, ben],
      grants: [grant(ana, plumbing, 'NEEDS_IMPROVEMENT')],
    });
    expect(result.picked?.technicianId).toBe(ana.id);
    expect(pickedReason(result.picked!, 'MAJOR')).toBe(
      'Ana: Plumbing (needs improvement); major job -- nobody holds this any better.',
    );
  });

  it('keeps a limited technician off a major job', () => {
    const result = rankWorkOrderTechnicians({
      skills: [heater],
      scope: 'MAJOR',
      technicians: [ana, ben],
      grants: [grant(ana, heater, 'LIMITED', 'MINOR REPAIRS ONLY'), grant(ben, heater, 'FULL', 'CAN REPLACE WATER HEATER')],
    });
    expect(result.picked?.technicianId).toBe(ben.id);
    expect(result.ranking[1].excludedBecause).toBe('limited on Water heater, and this is a major job');
  });

  it('picks nobody when only limited technicians hold a major job', () => {
    const result = rankWorkOrderTechnicians({
      skills: [heater],
      scope: 'MAJOR',
      technicians: [ana],
      grants: [grant(ana, heater, 'LIMITED')],
    });
    expect(result.picked).toBeNull();
  });

  it('breaks a tie on the lighter day, then by name', () => {
    const result = rankWorkOrderTechnicians({
      skills: [plumbing],
      scope: 'MINOR',
      technicians: [{ ...ana, load: 3 }, { ...ben, load: 1 }, { ...cal, load: 1 }],
      grants: [grant(ana, plumbing, 'FULL'), grant(ben, plumbing, 'FULL'), grant(cal, plumbing, 'FULL')],
    });
    expect(result.ranking.map((r) => r.displayName)).toEqual(['Ben', 'Cal', 'Ana']);
  });

  it('picks nobody for a job with no skills', () => {
    const result = rankWorkOrderTechnicians({
      skills: [],
      scope: 'MINOR',
      technicians: [ana],
      grants: [],
    });
    expect(result.picked).toBeNull();
  });
});

describe('already working nearby (2026-11-25)', () => {
  // The office: "auto assign by tech and clusters of existing job, and close to the job".
  it('prefers, among the equally skilled, the one already working closest, over a lighter day', () => {
    const result = rankWorkOrderTechnicians({
      skills: [plumbing],
      scope: 'MINOR',
      technicians: [
        { ...ana, load: 0, nearestMiles: null },
        { ...ben, load: 4, nearestMiles: 6.4 },
        { ...cal, load: 3, nearestMiles: 1.2 },
      ],
      grants: [grant(ana, plumbing, 'FULL'), grant(ben, plumbing, 'FULL'), grant(cal, plumbing, 'FULL')],
    });
    expect(result.ranking.map((r) => r.technicianId)).toEqual([cal.id, ben.id, ana.id]);
  });

  it('never lets nearby beat a better skill', () => {
    const result = rankWorkOrderTechnicians({
      skills: [plumbing],
      scope: 'MINOR',
      technicians: [
        { ...ana, nearestMiles: 15 },
        { ...ben, nearestMiles: 0.5 },
      ],
      grants: [grant(ana, plumbing, 'FULL'), grant(ben, plumbing, 'LIMITED', 'MINOR REPAIRS ONLY')],
    });
    expect(result.picked?.technicianId).toBe(ana.id);
  });

  it('treats a job more than 10 miles off as not nearby, and falls back to the lighter day', () => {
    const result = rankWorkOrderTechnicians({
      skills: [plumbing],
      scope: 'MINOR',
      technicians: [
        { ...ana, load: 5, nearestMiles: 10.5 },
        { ...ben, load: 1, nearestMiles: 14 },
      ],
      grants: [grant(ana, plumbing, 'FULL'), grant(ben, plumbing, 'FULL')],
    });
    expect(result.picked?.technicianId).toBe(ben.id);
  });

  it('says how close in the reason, or that nobody was close', () => {
    const near = rankWorkOrderTechnicians({
      skills: [plumbing],
      scope: 'MINOR',
      technicians: [{ ...cal, load: 3, nearestMiles: 1.24 }],
      grants: [grant(cal, plumbing, 'FULL')],
    });
    expect(pickedReason(near.picked!, 'MINOR')).toBe('Cal: Plumbing; minor job; already working 1.2 mi away (3 jobs that day).');

    const far = rankWorkOrderTechnicians({
      skills: [plumbing],
      scope: 'MINOR',
      technicians: [{ ...cal, load: 1, nearestMiles: 22 }],
      grants: [grant(cal, plumbing, 'FULL')],
    });
    expect(pickedReason(far.picked!, 'MINOR')).toBe('Cal: Plumbing; minor job; no job within 10 miles that day, fewest visits.');
  });

  it('says nothing about distance when it could not be measured', () => {
    const result = rankWorkOrderTechnicians({
      skills: [plumbing],
      scope: 'MINOR',
      technicians: [ana],
      grants: [grant(ana, plumbing, 'FULL')],
    });
    expect(pickedReason(result.picked!, 'MINOR')).toBe('Ana: Plumbing; minor job.');
  });
});
