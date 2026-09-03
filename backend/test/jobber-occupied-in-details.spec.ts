import { InspectionType } from '@prisma/client';

import {
  occupiedInspectionInDetails,
  resolveVisitType,
  visitTypeRules,
  isSyncedType,
} from '../src/integrations/jobber/jobber.visit-type';
import { visitsQuery, VISIT_DETAILS_FIELD } from '../src/integrations/jobber/jobber.queries';

/**
 * A filter delivery that is also a walkthrough.
 *
 * This office books both as one visit: the title reads "Q3 2026 Tenant Benefit
 * Package" and the details read "Filter Change: 18x36x1 + Pest Control +
 * Occupied Inspection". The title alone types it a delivery, which this
 * integration deliberately does not import — so seventy-three real occupied
 * inspections were dropped and not one had ever reached the system.
 */

const rules = visitTypeRules({});
const TBP = '19803 Bolton Bridge Ln - Zone 1 - Q3 2026 Tenant Benefit Package';

describe('reading an occupied inspection out of a visit’s details', () => {
  it('recognises the phrase the office actually writes', () => {
    expect(
      occupiedInspectionInDetails('Filter Change: 18x36x1 + Pest Control + Occupied Inspection'),
    ).toBe(true);
  });

  it('is not fooled by case or surrounding text', () => {
    expect(occupiedInspectionInDetails('pest control + OCCUPIED INSPECTION + keys')).toBe(true);
  });

  it('says no to a delivery that is only a delivery', () => {
    expect(occupiedInspectionInDetails('Filter Change: 18x36x1 + Pest Control')).toBe(false);
    expect(occupiedInspectionInDetails(null)).toBe(false);
    expect(occupiedInspectionInDetails(undefined)).toBe(false);
  });

  it('does not fire on the word "inspection" alone', () => {
    // Details are free text. "Inspection" appears in sentences that are not
    // about an occupied inspection at all, and typing a visit wrongly picks the
    // wrong area scope and changes what a move-out is later compared against.
    expect(occupiedInspectionInDetails('No inspection needed, filters only')).toBe(false);
    expect(occupiedInspectionInDetails('Roof inspection scheduled separately')).toBe(false);
  });
});

describe('what the title still decides on its own', () => {
  it('types a Tenant Benefit Package as a delivery, which is not imported', () => {
    const resolved = resolveVisitType(TBP, rules);
    expect(resolved).toEqual({
      outcome: 'RESOLVED',
      inspectionType: InspectionType.AC_FILTER_DELIVERY,
    });
    expect(isSyncedType(InspectionType.AC_FILTER_DELIVERY)).toBe(false);
  });

  it('leaves a move-out a move-out whatever its details say', () => {
    // The upgrade only ever applies to a delivery. A title somebody chose is a
    // deliberate statement; details are free text, and letting them overrule a
    // title would reclassify work on a phrase nobody was asked to be careful
    // about.
    const resolved = resolveVisitType('123 Main St - Move out inspection', rules);
    expect(resolved).toEqual({ outcome: 'RESOLVED', inspectionType: InspectionType.MOVE_OUT });
  });

  it('does not rescue an unknown title', () => {
    // "General Maintenance" is refused today and stays refused. Details cannot
    // promote a visit nobody typed — that is a person's decision.
    expect(resolveVisitType('7811 Blackbird Lane - Zone 4 - Turnover', rules).outcome).toBe(
      'UNKNOWN',
    );
  });
});

describe('the query that carries the details', () => {
  it('asks for the field by default', () => {
    expect(visitsQuery()).toContain(VISIT_DETAILS_FIELD);
  });

  it('can be built without it, so a rejected field cannot stop the sync', () => {
    // The one field here whose name is not proven against this account's
    // schema. An unknown field fails the whole GraphQL query, so the worker
    // drops it and retries rather than losing every visit to gain one
    // enrichment.
    const withoutDetails = visitsQuery(null);
    expect(withoutDetails).not.toContain(VISIT_DETAILS_FIELD);
    // Still a usable query: the fields the sync actually depends on remain.
    for (const field of ['id', 'title', 'startAt', 'visitStatus', 'completedAt'])
      expect(withoutDetails).toContain(field);
  });
});
