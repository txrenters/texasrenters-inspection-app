import {
  AreaCategory,
  AreaChecklistItemKind,
  AreaEnvironment,
  InspectionSource,
  InspectionStatus,
  InspectionType,
  Prisma,
  PropertyAreaStatus,
} from '@prisma/client';

import {
  AreaScope,
  HVAC_CHECKLIST,
  OCCUPIED_CHECKLIST,
  STANDARD_LAYOUT_NOTE,
  STANDARD_LAYOUT_SOURCE,
  STANDARD_PROPERTY_LAYOUT,
  areaScopeFor,
  checklistKindFor,
  checklistTemplateFor,
  layoutAreasFor,
  inspectionComparesToBaseline,
  keywordsFromLabel,
} from '@texasrenters/shared';

import { ApplicationError } from '../common/errors';
import type { PrismaService } from '../common/prisma.service';

/**
 * Every rule that decides what an inspection *is*, independent of who asked.
 *
 * This used to live inside `AdminService.createInspection`, which was fine
 * while a human administrator was the only way an inspection could come into
 * existence. It stops being fine the moment a second source — Jobber, which
 * schedules the visits — needs to create one: a writer that goes straight to
 * `inspection.create` produces a row with no areas, and an inspection with no
 * areas is not a smaller inspection, it is a technician standing in a property
 * with nothing to fill in. Everything that must be true of an inspection
 * therefore lives here, where both callers reach it, rather than in the branch
 * that happens to have been written first.
 *
 * What is deliberately *not* here: audit actor, technician assignment,
 * notification and cache invalidation. Those differ per caller — an
 * administrator's action is attributed to them, a synced visit is not — so they
 * stay with the caller that knows the answer.
 */

export type InspectionCreationClient = Prisma.TransactionClient | PrismaService;

/**
 * A building whose portfolio is either absent or active.
 *
 * Buildings can have no portfolio at all, and filtering on the relation alone
 * would drop every one of them, because an absent relation cannot satisfy
 * `isActive` — so an unassigned property would vanish from the app entirely
 * rather than merely lack an ownership grouping. Nested in `AND` so it composes
 * with a search `OR` on the same query.
 */
export const PORTFOLIO_VISIBLE = {
  AND: [{ OR: [{ portfolioId: null }, { portfolio: { isActive: true } }] }],
} satisfies Prisma.PropertywareBuildingWhereInput;

export interface InspectionCreationInput {
  organizationId: string;
  /** A `PropertywareBuilding` id — not a `Property` id. The two tables are not
   * the same set of rows, and only this one can back an inspection. */
  buildingId: string;
  unitId?: string | null;
  leaseId?: string | null;
  inspectionType: InspectionType;
  /** Date only; the column is DATE and cannot carry a clock value. */
  scheduledAt: Date;
  /** Jobber's clock time for the visit, when it has one. Both null for
   * anything booked here — which the app renders as a day, not as midnight. */
  scheduledStartAt?: Date | null;
  scheduledEndAt?: Date | null;
  areaIds?: string[] | null;
  allowTechnicianAreaCapture?: boolean;
}

export interface InspectionRecordDetails {
  priority: string;
  internalNotes?: string | null;
  createdById: string | null;
  /** Defaults to MANUAL, so a caller that has never heard of Jobber cannot
   * accidentally produce a row the sync believes it owns. */
  source?: InspectionSource;
  jobberVisitId?: string | null;
  jobberJobId?: string | null;
  jobberUpdatedAt?: Date | null;

  /**
   * For work that was already finished before this record existed.
   *
   * Jobber closes a move-in when the visit completes, and a walkthrough done
   * elsewhere reaches us only as a finished visit. Recording it as `SCHEDULED`
   * would put a job somebody already did on a technician's phone — the
   * technician queue is `SCHEDULED` and `IN_PROGRESS` only, so `COMPLETED` is
   * what keeps it off.
   *
   * Defaults to the column default, so a caller that does not pass this gets
   * exactly the behaviour it had before.
   */
  status?: InspectionStatus;
  completedAt?: Date | null;
}

export type InspectionPlan = Awaited<ReturnType<typeof resolveInspectionPlan>>;

export async function requireBuilding(
  tx: InspectionCreationClient,
  organizationId: string,
  id: string,
  active: boolean,
) {
  const property = await tx.propertywareBuilding.findFirst({
    where: {
      id,
      organizationId,
      ...(active ? { isActive: true, ...PORTFOLIO_VISIBLE } : {}),
    },
    select: {
      id: true,
      externalId: true,
      name: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      portfolio: { select: { name: true } },
    },
  });
  if (!property)
    throw new ApplicationError(
      422,
      'INVALID_ACTIVE_PROPERTY',
      'Select an active synchronized property.',
    );
  return property;
}

export async function resolveLifecycleBaseline(
  tx: InspectionCreationClient,
  input: {
    organizationId: string;
    propertyId: string;
    unitId: string | null;
    leaseId: string | null;
    inspectionType: InspectionType;
    scheduledAt: Date;
  },
) {
  /**
   * The baseline is linked when one exists, and its absence blocks nothing.
   *
   * This used to refuse: no completed move-in for the property, unit and lease
   * meant no occupied, back-to-market or move-out inspection could be created
   * at all. On the live calendar that rejected ten visits, every one of them a
   * move-out and two of them happening that day.
   *
   * Jobber is the scheduling source of record. If the office booked the visit
   * the visit is real, and refusing to represent it does not stop it happening
   * — it only stops a technician being told about it, which is the worst of
   * both outcomes.
   *
   * Nothing is lost by linking optimistically. `ComparisonService` re-resolves
   * the baseline when it runs, preferring this link but falling back to a scope
   * search, so a move-out created before its move-in still finds it later. And
   * `baselineInspectionId` was already nullable and already handled: deleting a
   * move-in nulls it on every inspection that pointed at it.
   *
   * The predecessor chain went with it — back-to-market demanding a completed
   * occupied, move-out demanding a completed back-to-market. Real calendars do
   * not run in that order, and a property entering the system mid-tenancy has
   * no way to ever satisfy it.
   */
  if (!inspectionComparesToBaseline(input.inspectionType)) return null;

  const baseline = await tx.inspection.findFirst({
    where: {
      organizationId: input.organizationId,
      propertywareBuildingId: input.propertyId,
      propertywareUnitId: input.unitId,
      propertywareLeaseId: input.leaseId,
      scheduledAt: { lt: input.scheduledAt },
      completedAt: { not: null },
      status: {
        in: [
          InspectionStatus.PROCESSING,
          InspectionStatus.REVIEW_REQUIRED,
          InspectionStatus.COMPLETED,
        ],
      },
      inspectionType: InspectionType.MOVE_IN,
    },
    orderBy: { scheduledAt: 'desc' },
    select: { id: true },
  });
  return baseline?.id ?? null;
}

export function propertySnapshot(
  property: Awaited<ReturnType<typeof requireBuilding>>,
  unit: {
    id: string;
    externalId: string;
    name: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  } | null,
) {
  return {
    property: {
      id: property.id,
      externalId: property.externalId,
      name: property.name,
      addressLine1: property.addressLine1,
      addressLine2: property.addressLine2,
      city: property.city,
      state: property.state,
      postalCode: property.postalCode,
      portfolio: property.portfolio?.name ?? 'Unassigned',
    },
    unit,
  };
}

export function leaseSnapshot(lease: {
  id: string;
  externalId: string;
  leaseName: string | null;
  sourceStatus: string | null;
  startDate: Date | null;
  endDate: Date | null;
  scheduledMoveOutDate: Date | null;
}) {
  return {
    id: lease.id,
    externalId: lease.externalId,
    leaseName: lease.leaseName,
    sourceStatus: lease.sourceStatus,
    startDate: lease.startDate,
    endDate: lease.endDate,
    scheduledMoveOutDate: lease.scheduledMoveOutDate,
  };
}

/**
 * Everything that has to be true before an inspection may exist.
 *
 * Returns the resolved property, unit, lease and area list rather than writing
 * anything, so a caller can validate a candidate visit — a Jobber sync deciding
 * whether a visit is bookable yet — without creating a row.
 */
export async function resolveInspectionPlan(
  tx: InspectionCreationClient,
  input: InspectionCreationInput,
) {
  const property = await requireBuilding(tx, input.organizationId, input.buildingId, true);
  const unit = input.unitId
    ? await tx.propertywareUnit.findFirst({
        where: {
          id: input.unitId,
          organizationId: input.organizationId,
          buildingId: property.id,
          isActive: true,
        },
        select: {
          id: true,
          externalId: true,
          name: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          postalCode: true,
        },
      })
    : null;
  if (input.unitId && !unit)
    throw new ApplicationError(
      422,
      'INVALID_ACTIVE_UNIT',
      'Select an active unit belonging to this property.',
    );
  if (!unit) {
    // Multi-unit buildings must inspect a specific unit; "entire property"
    // is only valid for buildings without active units.
    const activeUnits = await tx.propertywareUnit.count({
      where: { buildingId: property.id, organizationId: input.organizationId, isActive: true },
    });
    if (activeUnits > 0)
      throw new ApplicationError(
        422,
        'UNIT_REQUIRED',
        'This property has units. Select which unit this inspection covers.',
      );
  }
  if (input.leaseId && !unit)
    throw new ApplicationError(
      422,
      'LEASE_REQUIRES_UNIT',
      'Select the lease unit before selecting a lease.',
    );
  const lease = input.leaseId
    ? await tx.propertywareLease.findFirst({
        where: {
          id: input.leaseId,
          organizationId: input.organizationId,
          unitId: unit!.id,
          isActive: true,
        },
        select: {
          id: true,
          externalId: true,
          leaseName: true,
          sourceStatus: true,
          startDate: true,
          endDate: true,
          scheduledMoveOutDate: true,
        },
      })
    : null;
  if (input.leaseId && !lease)
    throw new ApplicationError(
      422,
      'INVALID_LEASE_RELATIONSHIP',
      'The selected lease is not valid for this unit.',
    );
  const scheduledAt = input.scheduledAt;
  // Only the ordering is checked, not whether the times fall on `scheduledAt`.
  // The day is a DATE and the times are UTC instants, so "same day" has no
  // answer without a timezone — and a visit booked at 7pm Central is genuinely
  // the next UTC day. Asserting agreement here would reject correct data;
  // whichever timezone the office schedules in belongs in the sync, not here.
  if (input.scheduledStartAt && input.scheduledEndAt && input.scheduledEndAt < input.scheduledStartAt)
    throw new ApplicationError(
      422,
      'INVALID_VISIT_WINDOW',
      'The visit end time cannot be before its start time.',
    );
  const baselineInspectionId = await resolveLifecycleBaseline(tx, {
    organizationId: input.organizationId,
    propertyId: property.id,
    unitId: unit?.id ?? null,
    leaseId: lease?.id ?? null,
    inspectionType: input.inspectionType,
    scheduledAt,
  });
  /**
   * The layout an inspection is built from.
   *
   * `archivedAt: null` was missing, and its absence is a plain bug rather than
   * anything to do with the template below: the column's own comment says
   * "archived areas drop out of active lists", and every new inspection was
   * scoping them straight back in. An administrator who archived a room they
   * had merged away saw it reappear on the next visit with nothing to explain
   * why.
   */
  const layoutWhere = (areaUnitId: string | null) => ({
    propertyId: property.id,
    unitId: areaUnitId,
    status: PropertyAreaStatus.APPROVED,
    archivedAt: null,
  });
  const layoutSelect = {
    orderBy: { inspectionOrder: 'asc' as const },
    // `category` for the roof scope, which picks areas by what the property
    // records rather than by anything the caller sent. `source` for the
    // standard-template rule below.
    select: { id: true, category: true, source: true },
  };
  // Prefer the unit's own approved layout; fall back to the building-level
  // layout when the unit has none (identical-layout buildings share one
  // building-level plan instead of duplicating it per unit).
  const unitAreas = unit
    ? await tx.propertyArea.findMany({ where: layoutWhere(unit.id), ...layoutSelect })
    : [];
  const layoutAreas = unitAreas.length
    ? unitAreas
    : await tx.propertyArea.findMany({ where: layoutWhere(null), ...layoutSelect });
  /**
   * A standard-template room stands aside once a real layout exists.
   *
   * Without this, a property seeded by an occupied visit and later given a
   * move-in report carries both sets — the import matches areas by normalised
   * name, and "Main Bedroom" is not "Bedroom 1" — so the next move-out walks
   * about twenty-five rooms instead of twelve. See `standardLayoutSuperseded`
   * for why they are superseded rather than deleted.
   */
  const approvedAreas = layoutAreasFor(layoutAreas);

  /**
   * The areas this inspection actually covers, decided three different ways.
   *
   * ALL — move-in and move-out take the whole approved layout. They are
   * compared to each other area by area, and a subset on either end leaves
   * the other with counterparts that never resolve.
   *
   * CHOSEN — occupied and back-to-market take what the office picked.
   *
   * HVAC_SYSTEM — an HVAC visit inspects the property's system as one
   * subject, against a standard checklist. It has no floor plan and no room
   * walk, so it is given a single system-managed area purely because the
   * evidence, checklist and finding tables all require one.
   *
   * A caller who sends `areaIds` for a type that does not offer a choice is
   * refused rather than quietly widened or narrowed. They asked for
   * something the type cannot honour, and silently doing otherwise is how a
   * move-out ends up scoped differently from the move-in it will be judged
   * against.
   *
   * Every id is checked against the approved set, so a stale or foreign id
   * fails here rather than producing an inspection missing an area nobody
   * notices until a technician is standing in the property.
   */
  const areaScope = areaScopeFor(input.inspectionType);
  const requestedAreaIds = input.areaIds?.length ? [...new Set(input.areaIds)] : null;
  if (requestedAreaIds && areaScope !== AreaScope.CHOSEN)
    throw new ApplicationError(
      422,
      'AREA_SELECTION_NOT_ALLOWED',
      areaScope === AreaScope.HVAC_SYSTEM
        ? 'An HVAC visit inspects the property system as a whole, so it cannot be limited to a selection.'
        : areaScope === AreaScope.ROOF_AREAS
          ? 'A roof inspection covers every area recorded as a roof, so it cannot be limited to a selection.'
          : 'A move-in or move-out covers every area, so it cannot be limited to a selection.',
    );
  if (requestedAreaIds) {
    const approvedIds = new Set(approvedAreas.map((area) => area.id));
    const unknown = requestedAreaIds.filter((id) => !approvedIds.has(id));
    if (unknown.length)
      throw new ApplicationError(
        422,
        'INVALID_AREA_SELECTION',
        'Select only approved areas belonging to this property.',
      );
  }
  const scopedAreas =
    areaScope === AreaScope.HVAC_SYSTEM
      ? // Resolved separately below: this one is not a subset of the approved
        // layout, and a property with no layout at all still gets an HVAC visit.
        []
      : areaScope === AreaScope.ROOF_AREAS
        ? approvedAreas.filter((area) => area.category === AreaCategory.ROOF)
        : requestedAreaIds
          ? approvedAreas.filter((area) => requestedAreaIds.includes(area.id))
          : approvedAreas;

  /**
   * The same refusal, for the same reason, against a different marker.
   *
   * A property whose layout records no roof would produce a roof inspection
   * covering nothing — a scheduling success that reaches the technician as
   * an empty job. Saying so names the fix: categorise the roof area.
   */
  if (areaScope === AreaScope.ROOF_AREAS && approvedAreas.length && !scopedAreas.length)
    throw new ApplicationError(
      409,
      'NO_ROOF_AREAS',
      'No approved area of this property is recorded as a roof. Set an area’s category to Roof before scheduling a roof inspection.',
    );

  const technicianWillCapture = input.allowTechnicianAreaCapture === true;
  /**
   * The floor-plan gate does not apply to an HVAC visit.
   *
   * It inspects equipment, not rooms — there is nothing on a floor plan it
   * needs. Requiring one is what made HVAC unschedulable on every property in
   * the portfolio.
   */
  if (areaScope !== AreaScope.HVAC_SYSTEM && !approvedAreas.length && !technicianWillCapture)
    throw new ApplicationError(
      409,
      'NO_APPROVED_AREAS',
      unit
        ? 'Approve a floor plan for this unit (or a building-level plan) before creating an inspection.'
        : 'Upload or define the property floor plan and approve its areas before creating an inspection.',
    );
  /**
   * A duplicate is the same *work* booked twice, so the type is part of what
   * makes two inspections the same thing.
   *
   * The type was missing from this check, which made every kind of visit
   * mutually exclusive on a date. HVAC is the case that exposed it: the
   * schema calls it "equipment maintenance, outside the tenancy lifecycle
   * chain", and an air-conditioning service has nothing to do with a move-in
   * that happens to fall on the same day. The office could not book one
   * behind the other.
   *
   * Terminal work does not block either. A completed or cancelled
   * inspection is a record, not a booking — a move-in finished this morning
   * is the evidence the unit is ready for the next visit, so treating it as
   * a clash left that unit unbookable for the rest of the day. Only a live
   * booking of the same type at the same time is genuinely a second copy of
   * the same job.
   */
  const duplicate = await tx.inspection.findFirst({
    where: {
      organizationId: input.organizationId,
      propertywareBuildingId: property.id,
      propertywareUnitId: unit?.id ?? null,
      inspectionType: input.inspectionType,
      scheduledAt,
      status: { notIn: [InspectionStatus.COMPLETED, InspectionStatus.CANCELLED] },
    },
    select: { id: true },
  });
  if (duplicate)
    throw new ApplicationError(
      409,
      'DUPLICATE_INSPECTION',
      'An inspection of this type is already scheduled for this unit at that time.',
    );

  return {
    organizationId: input.organizationId,
    property,
    unit,
    lease,
    inspectionType: input.inspectionType,
    scheduledAt,
    scheduledStartAt: input.scheduledStartAt ?? null,
    scheduledEndAt: input.scheduledEndAt ?? null,
    baselineInspectionId,
    approvedAreas,
    scopedAreas,
    technicianWillCapture,
  };
}

/**
 * The name every HVAC inspection's single area carries.
 *
 * Stable rather than generated, because it is the lookup key: one area per
 * property, reused by every HVAC visit that property ever has, so the checklist
 * responses and photos of successive visits stay attached to the same subject.
 */
export const HVAC_SYSTEM_AREA_NAME = 'HVAC System';

/**
 * Finds or creates the one area an HVAC inspection hangs off.
 *
 * An HVAC visit inspects equipment, not rooms. It has no floor plan and the
 * technician is never shown an area — but `InspectionArea`, `InspectionPhoto`,
 * `InspectionAreaChecklistResponse` and `InspectionFinding` all require one, so
 * there has to be exactly one to point at.
 *
 * APPROVED on creation, and `source` records that nobody drew it. It is
 * deliberately NOT part of any floor plan: it has no marker, no floor, and it
 * must never appear in a room walk, which is why it is created here rather than
 * through the floor-plan admin path.
 *
 * `isRequired` is false. The completion gate counts required areas that are
 * neither complete nor skipped, and an HVAC technician answers a checklist
 * rather than marking an area complete — a required area would block every
 * submission on a step the app never shows them.
 */
async function hvacSystemArea(tx: InspectionCreationClient, plan: InspectionPlan) {
  /**
   * The `Property` row has to exist before an area can point at it.
   *
   * `PropertyArea.propertyId` carries a *building* id but its foreign key
   * references `Property`, a separate table that is populated lazily — the
   * floor-plan admin calls the same upsert before every area it creates. Most
   * buildings have never had one, so creating the area first violates
   * `PropertyArea_propertyId_fkey` and takes the whole sync down with it.
   */
  await tx.property.upsert({
    where: { id: plan.property.id },
    update: {},
    create: {
      id: plan.property.id,
      organizationId: plan.organizationId,
      name: plan.property.name,
      // The same fallbacks the floor-plan admin uses. These columns are
      // required and a Propertyware building is not guaranteed to have them.
      addressLine1: plan.property.addressLine1 || 'Address not provided',
      city: plan.property.city || 'Not provided',
      state: plan.property.state || 'TX',
      postalCode: plan.property.postalCode || 'Not provided',
    },
  });

  const where = {
    propertyId: plan.property.id,
    unitId: plan.unit?.id ?? null,
    floorId: null,
    name: HVAC_SYSTEM_AREA_NAME,
  };
  const existing = await tx.propertyArea.findFirst({ where, select: { id: true } });
  if (existing) return existing.id;
  const created = await tx.propertyArea.create({
    data: {
      ...where,
      inspectionOrder: 0,
      isRequired: false,
      status: PropertyAreaStatus.APPROVED,
      source: 'SYSTEM',
      environment: AreaEnvironment.INDOOR,
      category: AreaCategory.UTILITY,
      notes: 'Created automatically for HVAC inspections. Not part of the floor plan.',
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Makes sure the organization's HVAC checklist exists.
 *
 * One list for the whole organization, not one per property. The HVAC checklist
 * asks the same nine questions about every system in the portfolio, so copying
 * it onto ~570 properties would mean keeping ~570 copies in step every time a
 * line is reworded.
 *
 * `skipDuplicates` rather than a count-then-insert: the partial unique index on
 * (organization, kind, label) where the area is null makes a re-run free, and
 * two inspections created at the same moment cannot produce two sets. Answers
 * already recorded against an item survive, because the row is reused rather
 * than replaced.
 *
 * Worth knowing: adding a line to the template reaches every organization at the
 * next HVAC inspection, but *removing* one does not — a row already inserted
 * stays until somebody archives it. That is the safe direction, since a live
 * item may already hold a technician's answers.
 */
async function ensureHvacChecklist(tx: InspectionCreationClient, organizationId: string) {
  await tx.areaChecklistItem.createMany({
    data: HVAC_CHECKLIST.map((item, index) => ({
      organizationId,
      propertyAreaId: null,
      kind: AreaChecklistItemKind.AIR_CONDITIONING,
      label: item.label,
      section: item.section,
      responseType: item.responseType,
      unit: item.unit ?? null,
      choices: item.choices ?? [],
      /**
       * Keywords only for the items a spoken walkthrough can cover.
       *
       * A reading is a number the technician types; no phrasing in a transcript
       * means "the split was 18 degrees", and pretending otherwise would tick a
       * measurement nobody took.
       */
      keywords: item.responseType === 'STATUS' ? keywordsFromLabel(item.label) : [],
      // The order of the printed form, which is the order it is walked.
      sortOrder: index,
    })),
    skipDuplicates: true,
  });
}

/**
 * Makes sure the organization's occupied checklist exists.
 *
 * Organization-wide for the same reason the HVAC list is, and for a stronger
 * one: "Room condition" is the same question in a kitchen and in a hallway, so
 * there is nothing per-area about it at all. Writing it per area would put two
 * rows on every area of every property and leave thousands of copies to be kept
 * in step when the office rewords an option.
 *
 * The answers stay separate regardless — `InspectionAreaChecklistResponse` is
 * unique on `(inspectionAreaId, checklistItemId)`, so every room records its own
 * answer against the one shared item.
 *
 * `skipDuplicates` and the same partial unique index the HVAC list relies on, so
 * a re-run is free and two inspections created at the same moment cannot produce
 * two sets. An answer already recorded survives, because the row is reused
 * rather than replaced.
 *
 * No keywords. These are not items a spoken walkthrough can tick: no phrasing in
 * a transcript means "the overall condition of this room is Fair", and matching
 * the bare word "condition" against narration would answer the question for the
 * technician. They are two taps, which is the entire point of the list.
 */
async function ensureOccupiedChecklist(tx: InspectionCreationClient, organizationId: string) {
  await tx.areaChecklistItem.createMany({
    data: OCCUPIED_CHECKLIST.map((item, index) => ({
      organizationId,
      propertyAreaId: null,
      kind: AreaChecklistItemKind.OCCUPIED,
      label: item.label,
      // Two items need no heading, and an empty-looking subheading above every
      // room is worse than none.
      section: null,
      responseType: item.responseType,
      unit: null,
      choices: item.choices,
      keywords: [],
      sortOrder: index,
    })),
    skipDuplicates: true,
  });
}

/**
 * Gives a property the standard layout when it has none, and returns the areas.
 *
 * The Jobber sync's own comment names the problem: visits are refused or
 * arrive empty "on a property with no approved plan, which is currently every
 * property in this portfolio". So an occupied inspection reached the technician
 * with no rooms, and the technician typed them in — at every property, on every
 * visit, inside the fifteen minutes the office allows for the whole walk.
 *
 * ── WHERE THIS RUNS, AND WHY NOT IN `resolveInspectionPlan` ──────────────────
 *
 * Here, in the writer. `resolveInspectionPlan` is deliberately read-only — the
 * Jobber sync calls it to validate a visit without writing anything — and this
 * has to create rows. `hvacSystemArea` sits here for exactly the same reason.
 *
 * ── WHY ONLY A CHOSEN SCOPE ──────────────────────────────────────────────────
 *
 * Occupied and back-to-market, not move-in or move-out. On those two the type
 * *overrides* `isRequired`, so every generated area becomes mandatory and a
 * technician at a one-bedroom property would have to skip the rooms this list
 * guessed at. Worse, a move-out is compared to its move-in area by area, and
 * seeding both ends from a guess would produce a comparison against rooms
 * nobody has seen.
 *
 * They lose nothing by waiting. The layout written here is the *property's*,
 * permanently — so the first occupied visit establishes it and every later
 * inspection of any type inherits it through the ordinary lookup.
 */
async function ensureStandardLayout(tx: InspectionCreationClient, plan: InspectionPlan) {
  /**
   * The `Property` row has to exist before an area can point at it.
   *
   * `PropertyArea.propertyId` carries a *building* id but its foreign key
   * references `Property`, a separate table populated lazily. Most buildings
   * have never had one, so creating an area first violates the foreign key and
   * takes the whole sync down with it — the same trap `hvacSystemArea`
   * documents, and the same upsert.
   */
  await tx.property.upsert({
    where: { id: plan.property.id },
    update: {},
    create: {
      id: plan.property.id,
      organizationId: plan.organizationId,
      name: plan.property.name,
      addressLine1: plan.property.addressLine1 || 'Address not provided',
      city: plan.property.city || 'Not provided',
      state: plan.property.state || 'TX',
      postalCode: plan.property.postalCode || 'Not provided',
    },
  });

  /**
   * Written at the unit when there is one, at the building when there is not.
   *
   * Mirrors the lookup in `resolveInspectionPlan`, which prefers a unit's own
   * layout and falls back to the building's. Seeding at the wrong level would
   * produce areas the next inspection does not find.
   */
  const unitId = plan.unit?.id ?? null;
  await tx.propertyArea.createMany({
    data: STANDARD_PROPERTY_LAYOUT.map((area, index) => ({
      propertyId: plan.property.id,
      unitId,
      floorId: null,
      name: area.name,
      inspectionOrder: index,
      isRequired: area.isRequired,
      // Approved, or the snapshot would exclude every one of them and this
      // would fix nothing. The provenance below is what keeps that honest.
      status: PropertyAreaStatus.APPROVED,
      source: STANDARD_LAYOUT_SOURCE,
      environment: area.environment as AreaEnvironment,
      category: (area.category as AreaCategory | null) ?? null,
      notes: STANDARD_LAYOUT_NOTE,
    })),
    // The unique index on (propertyId, unitId, floorId, name) is NULLS NOT
    // DISTINCT, so this is idempotent and two inspections created at the same
    // moment cannot produce two layouts.
    skipDuplicates: true,
  });

  const areas = await tx.propertyArea.findMany({
    where: { propertyId: plan.property.id, unitId, status: PropertyAreaStatus.APPROVED },
    orderBy: { inspectionOrder: 'asc' },
    select: { id: true, name: true, category: true, environment: true },
  });

  /**
   * The room checklists for the areas just created.
   *
   * Deterministic, from the shared table — never the AI generator. That makes a
   * provider call, and this runs inside the inspection-creation transaction,
   * where a 60-second call would be dropped by the pooler and lose the
   * inspection along with it. An administrator can regenerate a better list
   * later; a technician needs *a* list now.
   *
   * Occupied visits do not read these — their checklist is organization-wide —
   * but the move-in and move-out that inherit this layout do.
   */
  await tx.areaChecklistItem.createMany({
    data: areas.flatMap((area) =>
      checklistTemplateFor({
        name: area.name,
        category: area.category,
        environment: area.environment,
      }).map((label, index) => ({
        organizationId: plan.organizationId,
        propertyAreaId: area.id,
        kind: AreaChecklistItemKind.ROOM,
        label,
        keywords: keywordsFromLabel(label),
        sortOrder: index,
      })),
    ),
    skipDuplicates: true,
  });

  return areas.map((area) => ({ id: area.id, category: area.category }));
}

/**
 * Writes the inspection a resolved plan describes.
 *
 * Split from the resolution above so the area snapshot — the thing the whole
 * technician workflow reads — can never be skipped by a caller that only meant
 * to insert a row.
 */
export async function insertInspection(
  tx: InspectionCreationClient,
  plan: InspectionPlan,
  details: InspectionRecordDetails,
) {
  /**
   * HVAC resolves its area here rather than in the plan.
   *
   * `resolveInspectionPlan` is deliberately read-only — the Jobber sync calls it
   * to validate a visit without writing anything — and this one has to create a
   * row the first time a property is inspected.
   */
  let areaIds: string[];
  if (areaScopeFor(plan.inspectionType) === AreaScope.HVAC_SYSTEM) {
    await ensureHvacChecklist(tx, plan.organizationId);
    areaIds = [await hvacSystemArea(tx, plan)];
  } else {
    /**
     * An occupied visit walks ordinary rooms, so it resolves its areas exactly
     * as every other type does — only the questions differ. The list is written
     * here rather than at floor-plan approval because it is not a property's
     * list: it belongs to the organization, and a property that has never had an
     * occupied inspection has no reason to carry a copy.
     */
    if (checklistKindFor(plan.inspectionType) === 'OCCUPIED')
      await ensureOccupiedChecklist(tx, plan.organizationId);
    /**
     * A visit that walks rooms, at a property with no rooms recorded.
     *
     * Only when the scope is CHOSEN and the plan resolved to nothing — an
     * office selection that came back empty is a property with no approved
     * layout, which is currently every property in this portfolio. Move-in and
     * move-out are excluded on purpose; see `ensureStandardLayout`.
     *
     * After the checklist above, and independent of it: an occupied visit at a
     * property nobody has laid out needs both, and neither reads the other.
     */
    areaIds =
      areaScopeFor(plan.inspectionType) === AreaScope.CHOSEN && !plan.scopedAreas.length
        ? (await ensureStandardLayout(tx, plan)).map((area) => area.id)
        : plan.scopedAreas.map((area) => area.id);
  }
  try {
    return await tx.inspection.create({
      data: {
        organizationId: plan.organizationId,
        propertywareBuildingId: plan.property.id,
        propertywareUnitId: plan.unit?.id,
        propertywareLeaseId: plan.lease?.id,
        inspectionType: plan.inspectionType,
        baselineInspectionId: plan.baselineInspectionId,
        priority: details.priority,
        internalNotes: details.internalNotes,
        createdById: details.createdById,
        scheduledAt: plan.scheduledAt,
        scheduledStartAt: plan.scheduledStartAt,
        scheduledEndAt: plan.scheduledEndAt,
        source: details.source ?? InspectionSource.MANUAL,
        jobberVisitId: details.jobberVisitId,
        jobberJobId: details.jobberJobId,
        jobberUpdatedAt: details.jobberUpdatedAt,
        // Spread rather than assigned, so omitting them leaves the column
        // defaults exactly as they were for every existing caller.
        ...(details.status ? { status: details.status } : {}),
        ...(details.completedAt ? { completedAt: details.completedAt } : {}),
        // Recorded even when the property turned out to have areas after
        // all: it is the administrator's instruction to the technician, not
        // a description of what the property had at the time.
        allowTechnicianAreaCapture: plan.technicianWillCapture,
        propertySnapshot: propertySnapshot(plan.property, plan.unit),
        leaseSnapshot: plan.lease ? leaseSnapshot(plan.lease) : Prisma.JsonNull,
        areas: {
          create: areaIds.map((propertyAreaId) => ({ propertyAreaId })),
        },
      },
    });
  } catch (error) {
    /**
     * There is NO unique index behind the duplicate check in
     * `resolveInspectionPlan`. A comment here used to claim a "partial unique
     * index on (org, building, unit, scheduledAt)" was the race-proof backstop;
     * `pg_indexes` on this table lists only the primary key, and no migration
     * has ever created one. So the findFirst is the only gate, and two
     * concurrent creates can both pass it.
     *
     * That race is left open deliberately rather than papered over: the
     * matching index would have to be partial (`WHERE status NOT IN
     * ('COMPLETED','CANCELLED')`) to agree with the rule above, existing
     * rows would need checking against it first, and adding it silently
     * here would be a schema change nobody asked for. Booking the same
     * visit twice in the same second is also not a thing the office does by
     * hand.
     *
     * It stops being merely theoretical once a sync writes inspections on a
     * schedule, so it is worth revisiting alongside the Jobber worker rather
     * than inheriting unexamined.
     *
     * The mapping is kept because P2002 can still arrive from the nested
     * area creates, and a 409 is the honest answer to either.
     */
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new ApplicationError(
        409,
        'DUPLICATE_INSPECTION',
        'An inspection of this type is already scheduled for this unit at that time.',
      );
    throw error;
  }
}
