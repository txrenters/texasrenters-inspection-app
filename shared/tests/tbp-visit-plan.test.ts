import { describe, expect, it } from 'vitest';

import {
  tbpInspectionFor,
  tbpServicesLine,
  tbpServicesLineFromTenancy,
  tbpVisitDetails,
  withInspectionLink,
} from '../src/contracts/tbp-visit-plan.js';
import { parseVisitDetails } from '../src/contracts/visit-details.js';
import { reportableServices } from '../src/contracts/visit-services.js';

const plan = (managementPlan: string | null, hvacPlan: string | null) => ({ managementPlan, hvacPlan });

describe('which inspection a benefit-package visit is', () => {
  it('is an occupied inspection for everyone in Q1 and Q3', () => {
    for (const quarter of [1, 3] as const)
      expect(tbpInspectionFor(quarter, plan('Premium', 'On our AC Plan'))).toEqual({
        inspectionType: 'OCCUPIED',
        reason: 'OCCUPIED_QUARTER',
        needsReview: false,
      });
  });

  it.each([
    ['Premium', 'On our AC Plan'],
    ['Premium', 'Not Completed'],
    ['Plus', 'On our AC Plan'],
    ['Plus', 'Not Completed'],
    ['Premium', 'HVAC Covered by Warranty and Our Plan'],
    ['Plus', 'HVAC Covered by Warranty and Our Plan'],
  ])('is an HVAC inspection in Q2 and Q4 for %s / %s', (tier, hvac) => {
    for (const quarter of [2, 4] as const)
      expect(tbpInspectionFor(quarter, plan(tier, hvac))).toMatchObject({
        inspectionType: 'HVAC',
        reason: 'PLAN_INCLUDES_HVAC',
      });
  });

  /** "there are also standard and basic that has availed the HVAC plan" -- the office, 2026-09-16. */
  it.each([['Standard'], ['Basic']])('is an HVAC inspection for %s on our AC plan', (tier) => {
    expect(tbpInspectionFor(4, plan(tier, 'On our AC Plan'))).toMatchObject({
      inspectionType: 'HVAC',
      reason: 'HVAC_PLAN_ADDED',
    });
  });

  it.each([['Standard'], ['Basic']])('stays an occupied inspection for %s that has not added the plan', (tier) => {
    expect(tbpInspectionFor(4, plan(tier, 'Not Completed'))).toMatchObject({
      inspectionType: 'OCCUPIED',
      reason: 'HVAC_PLAN_NOT_ADDED',
      needsReview: false,
    });
  });

  it('stays an occupied inspection for anybody who opted out, Premium included', () => {
    for (const tier of ['Premium', 'Plus', 'Standard', 'Basic', 'BX'])
      expect(tbpInspectionFor(4, plan(tier, 'Opted out HVAC Plan'))).toMatchObject({
        inspectionType: 'OCCUPIED',
        reason: 'HVAC_OPTED_OUT',
      });
  });

  /** "Premium (w/o HVAC)" is its own plan; a substring match would sell 43 tenancies an HVAC inspection. */
  it('does not read "Premium (w/o HVAC)" as Premium', () => {
    expect(tbpInspectionFor(4, plan('Premium (w/o HVAC)', 'Not Completed'))).toMatchObject({
      inspectionType: 'OCCUPIED',
      reason: 'PLAN_WITHOUT_HVAC',
    });
  });

  it('flags a tier the rule does not name that says it is on our AC plan anyway', () => {
    for (const tier of ['Premium (w/o HVAC)', 'BX', 'MX'])
      expect(tbpInspectionFor(4, plan(tier, 'On our AC Plan'))).toEqual({
        inspectionType: 'OCCUPIED',
        reason: 'AC_PLAN_ON_OTHER_TIER',
        needsReview: true,
      });
  });

  it('flags Premium with no HVAC plan recorded rather than guessing', () => {
    expect(tbpInspectionFor(2, plan('Premium', null))).toEqual({
      inspectionType: 'OCCUPIED',
      reason: 'HVAC_PLAN_NOT_RECORDED',
      needsReview: true,
    });
  });

  it('reads the plan names however they are cased or suffixed', () => {
    expect(tbpInspectionFor(4, plan('  premium plan ', 'on our ac plan'))).toMatchObject({ inspectionType: 'HVAC' });
    expect(tbpInspectionFor(4, plan('BASIC', 'ON OUR AC PLAN'))).toMatchObject({ inspectionType: 'HVAC' });
  });
});

describe('the services line of a planned visit', () => {
  /** "Filter Change: 20x25x1 + Pest Control + Occupied Inspection -> HVAC Inspection if applicable". */
  it('makes the office’s occupied inspection an HVAC inspection where the rule applies', () => {
    expect(tbpServicesLine('Filter Change: 20x25x1 + Pest Control + Occupied Inspection', 'HVAC')).toBe(
      'Filter Change: 20x25x1 + Pest Control + HVAC Inspection',
    );
  });

  it('leaves an occupied inspection as the office wrote it where it does not', () => {
    const line = 'Filter Change: 20x25x1; 16x25x1 + Pest Control + Occupied Inspection (Basic Plan - Opted Out HVAC Plan)';
    expect(tbpServicesLine(line, 'OCCUPIED')).toBe(line);
  });

  it('keeps the plan note after the inspection', () => {
    expect(
      tbpServicesLine('Filter Change: 16x25x4 MEDIA + Pest Control + Occupied Inspection (Standard Plan)', 'HVAC'),
    ).toBe('Filter Change: 16x25x4 MEDIA + Pest Control + HVAC Inspection (Standard Plan)');
  });

  it.each([
    'Occuied Inspection',
    'Occupied Inspectio',
    'Occupied Inspect',
    'Occupied Insppection',
    'HAC Inspection',
    'HVAC Inspection',
  ])('reads "%s" from the office’s sheet as the inspection', (phrase) => {
    expect(tbpServicesLine(`Filter Change: 20x25x1 + Pest Control + ${phrase}`, 'OCCUPIED')).toBe(
      'Filter Change: 20x25x1 + Pest Control + Occupied Inspection',
    );
  });

  it('adds the inspection to a line that names none, before its note', () => {
    expect(tbpServicesLine('Filter Change: 16x25x4 MEDIA', 'HVAC')).toBe('Filter Change: 16x25x4 MEDIA + HVAC Inspection');
    expect(tbpServicesLine('Filter Change: 20x25x1 + Pest Control (Premium (w/o HVAC) - Opted out HVAC Plan)', 'OCCUPIED')).toBe(
      'Filter Change: 20x25x1 + Pest Control + Occupied Inspection (Premium (w/o HVAC) - Opted out HVAC Plan)',
    );
  });

  it('keeps the line on one line', () => {
    expect(tbpServicesLine('Filter Change: 20x25x1 + Occupied Inspection (Premium\tOpted out HVAC Plan)\n', 'OCCUPIED')).toBe(
      'Filter Change: 20x25x1 + Occupied Inspection (Premium Opted out HVAC Plan)',
    );
  });
});

describe('a services line for a tenancy the office’s sheet does not cover', () => {
  const tenancy = {
    managementPlan: 'Basic',
    hvacPlan: 'Opted out HVAC Plan',
    hvacFilterSizes: ['20x25x1', '16x25x4 Media'],
    hvacFilterLocation: null,
  };

  it('is written the way the sheet writes one', () => {
    expect(tbpServicesLineFromTenancy(tenancy, 'OCCUPIED')).toBe(
      'Filter Change: 20x25x1; 16x25x4 MEDIA + Pest Control + Occupied Inspection (Basic Plan - Opted Out HVAC Plan)',
    );
  });

  it('names the plan of a tenant who opted out, and nobody else’s', () => {
    expect(tbpServicesLineFromTenancy({ ...tenancy, managementPlan: 'Premium', hvacPlan: 'Not Completed' }, 'HVAC')).toBe(
      'Filter Change: 20x25x1; 16x25x4 MEDIA + Pest Control + HVAC Inspection',
    );
    expect(tbpServicesLineFromTenancy({ ...tenancy, managementPlan: 'Premium (w/o HVAC)' }, 'OCCUPIED')).toMatch(
      /\(Premium \(w\/o HVAC\) - Opted Out HVAC Plan\)$/,
    );
  });

  it('asks for the sizes when none are recorded', () => {
    expect(tbpServicesLineFromTenancy({ ...tenancy, hvacFilterSizes: [], hvacPlan: 'On our AC Plan' }, 'HVAC')).toBe(
      'Filter Change: Update filter sizes + Pest Control + HVAC Inspection',
    );
  });
});

describe('the Details of a planned visit', () => {
  const details = tbpVisitDetails('Filter Change: 20x25x1 + Pest Control + HVAC Inspection');

  /**
   * The phone asks the technician to report every service the Details booked
   * before they can submit. An HVAC visit still changes the filter and treats
   * for pests, so it has to ask for both.
   */
  it('asks the technician for the filter change and pest control on an HVAC visit too', () => {
    expect(reportableServices(parseVisitDetails(details))).toEqual(['filterChange', 'pestControl']);
  });

  it('carries the office’s completion steps after the services', () => {
    const read = parseVisitDetails(details);
    expect(read.filters.map((filter) => filter.size)).toEqual(['20x25x1']);
    expect(read.completionInstructions.length).toBeGreaterThan(3);
    expect(details.startsWith('Filter Change: 20x25x1 + Pest Control + HVAC Inspection\n\n')).toBe(true);
  });

  it('links the inspection before the completion steps, once', () => {
    const linked = withInspectionLink(details, 'https://console.example.com/inspections/1');

    expect(linked).toContain('HVAC Inspection\n\nTexas Renters inspection: https://console.example.com/inspections/1\n\nInstruction for completion');
    expect(withInspectionLink(linked, 'https://console.example.com/inspections/1')).toBe(linked);
    expect(parseVisitDetails(linked).completionInstructions).toEqual(parseVisitDetails(details).completionInstructions);
  });
});
