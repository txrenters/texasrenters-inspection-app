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
 * - So does a tenancy on any other plan -- BX, "Premium (w/o HVAC)" -- whose
 *   HVAC Plan says "On our AC Plan" (the office, asked about the 26 of those).
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
  | 'SET_BY_COORDINATOR';

export interface TbpInspectionDecision {
  inspectionType: TbpInspectionType;
  reason: TbpInspectionReason;
  /**
   * The report does not settle it, so somebody should look before publishing.
   *
   * A Premium or Plus tenancy whose HVAC Plan is blank or unrecognised: the
   * plan includes an HVAC inspection, but the rule asks the report to confirm
   * it. Planned as an occupied inspection, and shown to the office.
   */
  needsReview: boolean;
}

/** Why a stop is the kind of visit it is, in the office's words. */
export const TBP_INSPECTION_REASON_TEXT: Record<TbpInspectionReason, string> = {
  OCCUPIED_QUARTER: 'Q1 and Q3 are occupied inspections.',
  PLAN_INCLUDES_HVAC: 'Premium and Plus include the HVAC plan.',
  HVAC_PLAN_ADDED: 'On our AC Plan.',
  HVAC_OPTED_OUT: 'Opted out of the HVAC plan.',
  HVAC_PLAN_NOT_ADDED: 'Not on our AC Plan, and the management plan does not include it.',
  HVAC_PLAN_NOT_RECORDED: 'Premium or Plus, but the HVAC plan is not recorded.',
  SET_BY_COORDINATOR: 'Set by a coordinator.',
};

/** A tenancy as the tenant report describes its plan. */
export interface TbpTenancyPlan {
  managementPlan: string | null;
  hvacPlan: string | null;
}

type HvacPlan = 'ON_PLAN' | 'NOT_COMPLETED' | 'OPTED_OUT' | 'UNKNOWN';

/**
 * Whether the management plan includes the HVAC plan: Premium and Plus.
 *
 * Exact names only. "Premium (w/o HVAC)" is a different plan from "Premium" --
 * its name says so -- and a substring match would give its "Not Completed"
 * tenancies an HVAC inspection nobody sold them.
 */
function includesHvac(plan: string | null): boolean {
  const name = (plan ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/ plan$/, '');
  return name === 'premium' || name === 'plus';
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

  if (includesHvac(tenancy.managementPlan))
    return hvac === 'ON_PLAN' || hvac === 'NOT_COMPLETED'
      ? decision('HVAC', 'PLAN_INCLUDES_HVAC')
      : decision('OCCUPIED', 'HVAC_PLAN_NOT_RECORDED', true);

  // Every other plan -- Standard, Basic, BX, MX, Premium (w/o HVAC) -- gets
  // the HVAC inspection when the tenancy is on our AC plan, and not otherwise.
  return hvac === 'ON_PLAN' ? decision('HVAC', 'HVAC_PLAN_ADDED') : decision('OCCUPIED', 'HVAC_PLAN_NOT_ADDED');
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

/**
 * Details a coordinator wrote, made to name another inspection.
 *
 * Their text is kept. Only the services line -- the line joining services with
 * "+", which the sync and the phone read the visit by -- has its inspection
 * renamed, or named where it has none; a line already naming an inspection is
 * preferred over an earlier note that happens to hold a "+". Details with no
 * services line at all get `servicesLine` in front of them.
 */
export function detailsNamingInspection(
  details: string,
  inspectionType: TbpInspectionType,
  servicesLine: string,
): string {
  const lines = details.split(/\r?\n/);
  const named = lines.findIndex((line) => line.includes('+') && INSPECTION_ON_LINE.test(line));
  const services = named === -1 ? lines.findIndex((line) => line.includes('+')) : named;
  if (services === -1) return [servicesLine.trim(), details.trim()].filter(Boolean).join('\n\n');
  lines[services] = tbpServicesLine(lines[services]!, inspectionType);
  return lines.join('\n');
}

// ---------------------------------------------------------------- Units

/** A unit of a building, as Propertyware names it. */
export interface BuildingUnit {
  name: string;
  addressLine1: string | null;
}

const STREET_TYPES = new Set([
  'st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane', 'blvd', 'boulevard', 'ct', 'court',
  'way', 'pl', 'place', 'cir', 'circle', 'pkwy', 'parkway', 'trl', 'trail', 'ter', 'terrace', 'loop', 'hwy',
  'highway', 'cv', 'cove', 'xing', 'crossing', 'bnd', 'bend', 'sq', 'square',
]);

/** A street without its house number or street type, as a unit is labelled: "1/2 n main" for "5009 1/2 N Main St". */
function unitKey(text: string): string {
  const tokens = text.toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && /^\d+$/.test(tokens[0]!)) tokens.shift();
  if (tokens.length > 1 && STREET_TYPES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(' ');
}

/** "16x20x1 (1/2 N Main)" as the size and the unit named; a note before " - " stays with the size. */
function unitLabel(entry: string): { text: string; unit: string } | null {
  const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(entry.trim());
  if (!match) return null;
  const inner = match[2]!.trim();
  const dash = inner.lastIndexOf(' - ');
  const note = dash === -1 ? '' : inner.slice(0, dash).trim();
  return { text: note ? `${match[1]!.trim()} (${note})` : match[1]!.trim(), unit: dash === -1 ? inner : inner.slice(dash + 3) };
}

/**
 * One unit's filter sizes, from a building's sizes labelled by unit.
 *
 * The tenant report holds filter sizes per building, so for a building of
 * several units the office writes which unit each belongs to: 5009 N Main St's
 * are "20x20x1 (N Main)", "16x20x1 (1/2 N Main)", "14x18x1 (1/2 N Main)" and
 * "reusable window AC unit (no need to change - 1/4 N Main)". A label names a
 * unit when it is the unit's name, or its address without the house number and
 * street type. The unit's own sizes are kept without their label, sizes naming
 * another unit are left out, and a size with no unit label -- "(MEDIA)" is a
 * note, not a unit -- stays as the whole building's. Null when no size is
 * labelled by unit at all, so the caller keeps the building's sizes as they are.
 */
export function unitFilterSizes(
  sizes: readonly string[],
  unit: BuildingUnit,
  units: readonly BuildingUnit[],
): string[] | null {
  const keysOf = (candidate: BuildingUnit) =>
    [unitKey(candidate.name), candidate.addressLine1 ? unitKey(candidate.addressLine1) : ''].filter(Boolean);
  const mine = new Set(keysOf(unit));
  const anyUnit = new Set([...units, unit].flatMap(keysOf));

  let labelled = false;
  const kept: string[] = [];
  for (const entry of sizes) {
    const label = unitLabel(entry);
    const key = label ? unitKey(label.unit) : '';
    if (!label || !anyUnit.has(key)) {
      kept.push(entry);
      continue;
    }
    labelled = true;
    if (mine.has(key)) kept.push(label.text);
  }
  return labelled ? kept : null;
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
