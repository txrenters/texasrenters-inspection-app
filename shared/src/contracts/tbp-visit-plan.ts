/**
 * What a quarter's benefit-package visit is, and the Details it carries.
 *
 * The office's rules, stated on 2026-09-16:
 *
 * - Q1 and Q3 are occupied inspections for every enrolled tenancy.
 * - Q2 and Q4 are HVAC inspections for tenancies on the HVAC plan, and occupied
 *   inspections for everyone else.
 * - Premium and Plus include the HVAC plan, but the tenant report's HVAC Plan
 *   still has to say "On our AC Plan" or "Not Completed".
 * - Standard and Basic tenancies can add the HVAC plan, and the ones that have
 *   ("On our AC Plan") get the HVAC inspection too.
 *
 * Checked against the report before it was written down. Of the Standard and
 * Basic tenancies "On our AC Plan", 33 of 47 had their last HVAC inspection in
 * Q2 2026; of the ones "Not Completed", 5 of 68 did. The two "HVAC Covered by
 * Warranty and Our Plan" tenancies are Premium and Plus and had one in Q2 too.
 *
 * Pure, so the rule can be argued with in a test rather than read out of a plan
 * somebody already published.
 */

import type { QuarterNumber } from './quarter-plan.js';
import { OCCUPIED_COMPLETION_STEPS, bookingFromTenancy } from './visit-details-writer.js';

export const TBP_INSPECTION_TYPES = ['OCCUPIED', 'HVAC'] as const;
export type TbpInspectionType = (typeof TBP_INSPECTION_TYPES)[number];

export function isTbpInspectionType(value: unknown): value is TbpInspectionType {
  return (TBP_INSPECTION_TYPES as readonly unknown[]).includes(value);
}

/** The quarters a tenancy on the HVAC plan gets its HVAC inspection. */
export const HVAC_QUARTERS: readonly QuarterNumber[] = [2, 4];

export type TbpInspectionReason =
  | 'OCCUPIED_QUARTER'
  | 'PLAN_INCLUDES_HVAC'
  | 'HVAC_PLAN_ADDED'
  | 'HVAC_OPTED_OUT'
  | 'HVAC_PLAN_NOT_ADDED'
  | 'HVAC_PLAN_NOT_RECORDED'
  | 'AC_PLAN_ON_OTHER_TIER'
  | 'PLAN_WITHOUT_HVAC'
  | 'SET_BY_COORDINATOR';

export interface TbpInspectionDecision {
  inspectionType: TbpInspectionType;
  reason: TbpInspectionReason;
  /**
   * The report does not settle it, so somebody should look before publishing.
   *
   * A Premium or Plus tenancy with no recognisable HVAC Plan, and a tenancy on
   * a tier the rule does not name (BX, MX, Premium (w/o HVAC)) whose HVAC Plan
   * says "On our AC Plan" anyway. Both are planned as occupied inspections,
   * which is what the rule says, and both are shown to the office.
   */
  needsReview: boolean;
}

/** Why a stop is the kind of visit it is, in the office's words. */
export const TBP_INSPECTION_REASON_TEXT: Record<TbpInspectionReason, string> = {
  OCCUPIED_QUARTER: 'Q1 and Q3 are occupied inspections.',
  PLAN_INCLUDES_HVAC: 'Premium and Plus include the HVAC plan.',
  HVAC_PLAN_ADDED: 'On our AC Plan.',
  HVAC_OPTED_OUT: 'Opted out of the HVAC plan.',
  HVAC_PLAN_NOT_ADDED: 'Standard and Basic get an HVAC inspection only on our AC plan.',
  HVAC_PLAN_NOT_RECORDED: 'Premium or Plus, but the HVAC plan is not recorded.',
  AC_PLAN_ON_OTHER_TIER: 'On our AC Plan, but on a management plan the HVAC rule does not name.',
  PLAN_WITHOUT_HVAC: 'This management plan has no HVAC inspection.',
  SET_BY_COORDINATOR: 'Set by a coordinator.',
};

/** A tenancy as the tenant report describes its plan. */
export interface TbpTenancyPlan {
  managementPlan: string | null;
  hvacPlan: string | null;
}

type Tier = 'INCLUDES_HVAC' | 'CAN_ADD_HVAC' | 'OTHER';
type HvacPlan = 'ON_PLAN' | 'NOT_COMPLETED' | 'OPTED_OUT' | 'UNKNOWN';

/**
 * The management plan, by what it means for HVAC.
 *
 * Exact names only. "Premium (w/o HVAC)" is a different plan from "Premium" --
 * its name says so -- and a substring match would give its 43 tenancies an HVAC
 * inspection nobody sold them.
 */
function tierOf(plan: string | null): Tier {
  const name = (plan ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/ plan$/, '');
  if (name === 'premium' || name === 'plus') return 'INCLUDES_HVAC';
  if (name === 'standard' || name === 'basic') return 'CAN_ADD_HVAC';
  return 'OTHER';
}

/**
 * The report's HVAC Plan, which it holds in four forms.
 *
 * "HVAC Covered by Warranty and Our Plan" is on our plan: the warranty covers
 * the equipment, and the plan still covers the inspection.
 */
function hvacPlanOf(value: string | null): HvacPlan {
  const text = (value ?? '').trim().toLowerCase();
  if (/opted\s*out/.test(text)) return 'OPTED_OUT';
  if (/\bour\s+(?:ac\s+)?plan\b/.test(text)) return 'ON_PLAN';
  if (/not\s+completed/.test(text)) return 'NOT_COMPLETED';
  return 'UNKNOWN';
}

const decision = (
  inspectionType: TbpInspectionType,
  reason: TbpInspectionReason,
  needsReview = false,
): TbpInspectionDecision => ({ inspectionType, reason, needsReview });

/** Which inspection a tenancy's visit is this quarter, and why. */
export function tbpInspectionFor(quarter: QuarterNumber, tenancy: TbpTenancyPlan): TbpInspectionDecision {
  if (!HVAC_QUARTERS.includes(quarter)) return decision('OCCUPIED', 'OCCUPIED_QUARTER');

  const hvac = hvacPlanOf(tenancy.hvacPlan);
  // Before the tier: a tenant who opted out has no HVAC inspection, whatever
  // the plan would otherwise include.
  if (hvac === 'OPTED_OUT') return decision('OCCUPIED', 'HVAC_OPTED_OUT');

  switch (tierOf(tenancy.managementPlan)) {
    case 'INCLUDES_HVAC':
      return hvac === 'ON_PLAN' || hvac === 'NOT_COMPLETED'
        ? decision('HVAC', 'PLAN_INCLUDES_HVAC')
        : decision('OCCUPIED', 'HVAC_PLAN_NOT_RECORDED', true);
    case 'CAN_ADD_HVAC':
      return hvac === 'ON_PLAN' ? decision('HVAC', 'HVAC_PLAN_ADDED') : decision('OCCUPIED', 'HVAC_PLAN_NOT_ADDED');
    default:
      return hvac === 'ON_PLAN'
        ? decision('OCCUPIED', 'AC_PLAN_ON_OTHER_TIER', true)
        : decision('OCCUPIED', 'PLAN_WITHOUT_HVAC');
  }
}

// ---------------------------------------------------------------- Details

/**
 * The inspection on a services line, however the office typed it.
 *
 * Every spelling here is on the office's own Q4 sheet: "Occupied Inspection",
 * "Occuied Inspection", "Occupied Inspectio", "Occupied Inspect", "Occupied
 * Insppection" and "HAC Inspection", beside the "HVAC Inspection" this writes.
 */
const INSPECTION_ON_LINE = /\b(?:oc{1,2}u\w{0,3}ied|hv?ac)\s+ins?p+\w*/i;

const inspectionName = (inspectionType: TbpInspectionType) =>
  inspectionType === 'HVAC' ? 'HVAC Inspection' : 'Occupied Inspection';

/**
 * The note the office closes a services line with, and where it starts.
 *
 * "(Premium (w/o HVAC) - Opted out HVAC Plan)" nests, so the brackets are
 * counted rather than matched with a pattern.
 */
function closingNote(line: string): { start: number; text: string } | null {
  if (!line.endsWith(')')) return null;
  let depth = 0;
  for (let index = line.length - 1; index >= 0; index -= 1) {
    if (line[index] === ')') depth += 1;
    else if (line[index] === '(') {
      depth -= 1;
      if (depth === 0) return { start: index, text: line.slice(index) };
    }
  }
  return null;
}

/**
 * A services line naming this quarter's inspection.
 *
 * The office's own line, with "Occupied Inspection" made "HVAC Inspection"
 * where the HVAC rule applies and left an occupied inspection where it does not.
 * A misspelling is written correctly on the way through, because the phrase is
 * what the sync and the phone read the visit by. A line that names no
 * inspection gets one, before the plan note the office ends a line with.
 */
export function tbpServicesLine(line: string, inspectionType: TbpInspectionType): string {
  const text = line.replace(/[\t\r\n]+/g, ' ').trim();
  const name = inspectionName(inspectionType);
  if (INSPECTION_ON_LINE.test(text)) return text.replace(INSPECTION_ON_LINE, name);

  const note = closingNote(text);
  const services = (note ? text.slice(0, note.start) : text).trim().replace(/\+\s*$/, '').trim();
  return [services ? `${services} + ${name}` : name, note?.text].filter(Boolean).join(' ');
}

/** The tenancy fields a services line is written from, when the office wrote none. */
export interface TbpTenancyServices extends TbpTenancyPlan {
  hvacFilterSizes: string[];
  hvacFilterLocation: string | null;
}

/**
 * The services line for a tenancy the office's sheet does not cover.
 *
 * Written the way that sheet writes one -- sizes separated by "; ", "MEDIA"
 * after a thick filter, and a note closing the line only for a tenant who opted
 * out of the HVAC plan: "Filter Change: 20x25x1 + Pest Control + Occupied
 * Inspection (Basic Plan - Opted Out HVAC Plan)".
 */
export function tbpServicesLineFromTenancy(tenancy: TbpTenancyServices, inspectionType: TbpInspectionType): string {
  const prefill = bookingFromTenancy({
    zone: null,
    managementPlan: tenancy.managementPlan,
    hvacPlan: tenancy.hvacPlan,
    hvacFilterLocation: tenancy.hvacFilterLocation,
    hvacFilterSizes: tenancy.hvacFilterSizes,
    tbpEnrollment: 'Yes',
    tenantNames: [],
  });
  const sizes = prefill.filters.map((filter) => `${filter.size}${filter.media ? ' MEDIA' : ''}`);
  const tier = prefill.planTier;
  const note = prefill.hvacOptedOut
    ? `(${[tier ? (/plan|\)$/i.test(tier) ? tier : `${tier} Plan`) : null, 'Opted Out HVAC Plan'].filter(Boolean).join(' - ')})`
    : null;
  return [
    `Filter Change: ${sizes.length ? sizes.join('; ') : 'Update filter sizes'} + Pest Control + ${inspectionName(inspectionType)}`,
    note,
  ]
    .filter(Boolean)
    .join(' ');
}

const COMPLETION_HEADING = 'Instruction for completion';

/**
 * The whole Details of a planned benefit-package visit.
 *
 * The services line, then the office's completion steps pointed at the app --
 * the same block a visit booked from the console carries, which asks for the
 * filter change and pest control on an HVAC visit as much as an occupied one.
 */
export function tbpVisitDetails(servicesLine: string): string {
  return [servicesLine.trim(), [COMPLETION_HEADING, ...OCCUPIED_COMPLETION_STEPS].join('\n')].join('\n\n');
}

/**
 * The Details with a link to the inspection, before the completion steps.
 *
 * Added when the inspection exists, which is not until the plan is published.
 * Before the steps because everything after their heading is read as one of
 * them.
 */
export function withInspectionLink(details: string, inspectionUrl: string): string {
  const link = `Texas Renters inspection: ${inspectionUrl}`;
  if (details.includes(link)) return details;
  const heading = details.indexOf(COMPLETION_HEADING);
  if (heading < 0) return [details.trim(), link].filter(Boolean).join('\n\n');
  return [details.slice(0, heading).trim(), link, details.slice(heading)].filter(Boolean).join('\n\n');
}
