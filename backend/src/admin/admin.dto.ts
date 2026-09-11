import {
  AiProvider,
  AreaCategory,
  AreaEnvironment,
  InspectionType,
  SkillRequirementLevel,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class PaginationDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  search?: string;
}

export class PropertyListQueryDto extends PaginationDto {
  @IsOptional() @IsUUID() portfolioId?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(40) state?: string;
  @IsOptional() @IsIn(['true', 'false']) active?: string;
  @IsOptional() @IsIn(['true', 'false']) hasUpcomingMoveOut?: string;
  @IsOptional() @IsIn(['true', 'false']) hasUnassignedInspection?: string;

  /**
   * Whether a tenant is in residence — **not** whether we still manage it.
   *
   * Those are two different Propertyware fields and conflating them would be a
   * real error: `isActive` (the `active` flag) says the property is under
   * management, while occupancy lives in `sourceStatus`. 132 of the 574 active
   * properties are `Vacant`, and every one of them is still managed and still
   * inspectable — a move-out inspection happens *because* a property became
   * vacant.
   *
   * A string enum rather than a boolean because Propertyware writes the words,
   * and a third value already exists in the data (`Inactive`) that is neither.
   */
  @IsOptional() @IsIn(['OCCUPIED', 'VACANT']) occupancy?: string;
}

export class TenantListQueryDto extends PaginationDto {
  /**
   * `TBP` narrows to tenancies the office has confirmed are enrolled.
   *
   * Deliberately not a boolean. Propertyware writes `Yes`, `No` and
   * `Not Verified`, and the third means nobody has checked — a boolean would
   * file those twelve tenancies under whichever side the coercion picked.
   */
  @IsOptional() @IsIn(['TBP', 'NOT_TBP']) enrollment?: string;
  @IsOptional() @IsIn(['true', 'false']) active?: string;
}

export class PortfolioListQueryDto extends PaginationDto {}

export class UnitListQueryDto extends PaginationDto {
  @IsOptional() @IsIn(['true', 'false']) active?: string;
  @IsOptional() @IsIn(['true', 'false']) vacant?: string;
}

export class LeaseListQueryDto extends PaginationDto {
  @IsOptional() @IsString() @MaxLength(80) status?: string;
  @IsOptional() @IsDateString() scheduledMoveOutFrom?: string;
  @IsOptional() @IsDateString() scheduledMoveOutTo?: string;
  @IsOptional() @IsIn(['true', 'false']) active?: string;
}

export class InspectionListQueryDto extends PaginationDto {
  @IsOptional() @IsString() portfolioId?: string;
  @IsOptional() @IsUUID() propertyId?: string;
  @IsOptional() @IsUUID() technicianId?: string;
  @IsOptional() @IsEnum(InspectionType) inspectionType?: InspectionType;
  @IsOptional() @IsIn(['ASSIGNED', 'UNASSIGNED']) assignmentStatus?: string;
  @IsOptional()
  @IsIn(['SCHEDULED', 'IN_PROGRESS', 'PROCESSING', 'REVIEW_REQUIRED', 'COMPLETED', 'CANCELLED'])
  status?: string;
  @IsOptional() @IsDateString() scheduledFrom?: string;
  @IsOptional() @IsDateString() scheduledTo?: string;
  @IsOptional() @IsIn(['true', 'false']) unassignedOnly?: string;
}

export class CreateAdminInspectionDto {
  @IsUUID() propertyId!: string;
  @IsOptional() @IsUUID() unitId?: string;
  @IsOptional() @IsUUID() leaseId?: string;
  @IsOptional() @IsUUID() technicianId?: string;
  @IsDateString() scheduledAt!: string;
  @IsOptional() @IsEnum(InspectionType) inspectionType: InspectionType = InspectionType.MOVE_IN;
  @IsOptional() @IsIn(['STANDARD', 'HIGH']) priority = 'STANDARD';
  @IsOptional() @IsString() @MaxLength(2000) internalNotes?: string;
  @IsOptional() @IsString() @MaxLength(120) idempotencyKey?: string;
  /**
   * The areas to inspect, when the type does not demand all of them.
   *
   * Occupied, back-to-market and HVAC inspect a chosen part of the property, so
   * the scope is stated here and only these areas are attached. Omitted means
   * every approved area, which is what a move-in and move-out always get —
   * sending a subset for those is refused rather than silently widened, because
   * a move-out missing an area has no counterpart in its move-in and the
   * comparison drops it without a trace.
   */
  @IsOptional() @IsUUID('4', { each: true }) areaIds?: string[];
  /**
   * Schedule without an approved floor plan and let the technician survey the
   * areas on site. Their areas are written to the property as DRAFT, so an
   * administrator still approves the permanent layout.
   */
  @IsOptional() @IsBoolean() allowTechnicianAreaCapture?: boolean;
}

export class UpdateAdminInspectionDto {
  @IsOptional() @IsDateString() scheduledAt?: string;
  @IsOptional() @IsIn(['STANDARD', 'HIGH']) priority?: string;
  @IsOptional() @IsString() @MaxLength(2000) internalNotes?: string;
  // Finalization (COMPLETED) is a separate, permission-gated action; this generic
  // update only allows cancellation.
  @IsOptional() @IsIn(['CANCELLED']) status?: string;
  @IsOptional() @IsString() @MaxLength(500) cancellationReason?: string;
  /**
   * The report's closing block, written at sign-off.
   *
   * Kept apart from `internalNotes`, which is deliberately never published —
   * these three are printed on the document a tenant and an owner read. Folding
   * them into the internal note would either leak it or bury them.
   */
  @IsOptional() @IsString() @MaxLength(1000) nextInspectionAlert?: string;
  @IsOptional() @IsString() @MaxLength(4000) maintenanceComments?: string;
  @IsOptional() @IsString() @MaxLength(4000) generalComments?: string;
}

/** Finalize (complete) an inspection — a human-only decision (spec §11). */
export class FinalizeInspectionDto {
  // Required only to override the unresolved-required-items block; the override
  // is recorded in the audit trail.
  @IsOptional() @IsString() @MinLength(2) @MaxLength(500) overrideReason?: string;
}

/**
 * Close an inspection the technician never submitted.
 *
 * The reason is **required**, unlike the finalize override: this skips the
 * submit and review steps entirely, so the only record of why it was closed is
 * what the person types here.
 */
export class CompleteInspectionDto {
  @IsString() @MinLength(2) @MaxLength(500) reason!: string;
}

/** Mark an inspection TBD / pending-finalization (spec §11). */
export class InspectionTbdDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** Require a follow-up inspection with an optional planned date and tasks. */
export class InspectionFollowUpDto {
  @IsOptional() @IsDateString() dueAt?: string;
  @IsOptional() @IsString() @MaxLength(2000) tasks?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/**
 * Ask the technician for more evidence in one specific area.
 *
 * The note is required: a request that does not say what is wrong sends the
 * technician back to a finished room with nothing to act on, which is the
 * failure this whole route exists to fix.
 *
 * `checklistItemIds` is optional — omitted or empty means the whole area. When
 * given, the ids are checked against that area's own checklist, so a request
 * can never point at an item the technician's app will not show.
 */
export class CreateEvidenceRequestDto {
  @IsUUID() inspectionAreaId!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  checklistItemIds?: string[];
  @IsString() @MinLength(3) @MaxLength(1000) note!: string;
}

/** Move an inspection into administrator review / request more evidence. */
export class InspectionUnderReviewDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/**
 * Send a submitted or finalized inspection back to the technician (spec §11).
 *
 * The reason is required, unlike the other review transitions. This one can
 * reverse a finalization — the human decision that closed the inspection — so
 * the audit trail has to say why on every use, not only when overriding.
 */
export class ReopenInspectionDto {
  // Trimmed before validation, or "  " satisfies MinLength(2) and the audit
  // trail records whitespace as the justification for reversing a
  // finalization. The web dialog trims already; the API is where the guarantee
  // has to hold unconditionally.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason!: string;
}

/** Merge a duplicate inspection area into another within the same inspection. */
/**
 * Areas to add to an inspection that is already under way.
 *
 * Ids of *property* areas, not inspection areas: the caller is choosing from the
 * property's approved layout, and the InspectionArea row is what this creates.
 *
 * A list rather than one id, because the office discovers a missed room and a
 * missed hallway in the same breath, and two requests would mean two
 * notifications on the technician's handset for one decision.
 */
export class AddInspectionAreasDto {
  @IsArray()
  @ArrayMinSize(1)
  // The whole layout of a large property, and nothing near a runaway payload.
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  propertyAreaIds!: string[];
}

export class MergeInspectionAreasDto {
  @IsUUID() sourceAreaId!: string;
  @IsUUID() targetAreaId!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

const COMPARISON_CLASSIFICATIONS = [
  'UNCHANGED',
  'IMPROVED',
  'NEW_DAMAGE',
  'WORSENED',
  'RESOLVED',
  'MISSING_BASELINE',
  'MISSING_MOVE_OUT_EVIDENCE',
  'NOT_COMPARABLE',
  'REQUIRES_REVIEW',
] as const;

/** Approve or reject a move-in vs move-out comparison (spec §12). */
export class ComparisonReviewDto {
  @IsIn(['APPROVED', 'REJECTED']) decision!: 'APPROVED' | 'REJECTED';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** Override a single area comparison's classification, with an audit trail. */
export class AreaComparisonOverrideDto {
  @IsIn(COMPARISON_CLASSIFICATIONS) classification!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** Configure a charge rule (spec §13/§14) — e.g. the unauthorized-pet amount. */
export class ChargeRuleDto {
  @IsOptional() @IsString() @MaxLength(60) code?: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000) amount!: number;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional()
  @IsIn(['PER_UNIQUE_ENTITY', 'FLAT', 'PER_UNIT'])
  calculationType?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** A technician's pet observation (evidence only) during an occupied inspection. */
export class PetObservationDto {
  @IsString() @MinLength(1) @MaxLength(120) temporaryLabel!: string;
  @IsString() @MinLength(1) @MaxLength(60) species!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(500) characteristics?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsUUID() propertyAreaId?: string;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) photoIds?: string[];
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) mediaIds?: string[];
  @IsOptional() @IsUUID() possibleDuplicateOfId?: string;
  /**
   * Client-supplied, so a retried submission records one sighting.
   *
   * Optional: a caller that omits it behaves exactly as before. The mobile
   * app sends one because it will be retrying these from a queue.
   */
  @IsOptional() @IsString() @MaxLength(120) idempotencyKey?: string;
}

/** A reviewer's determination for a pet candidate (uniqueness + authorization). */
export class PetCandidateReviewDto {
  @IsIn(['PENDING_REVIEW', 'UNIQUE_PET', 'DUPLICATE', 'INSUFFICIENT_EVIDENCE'])
  reviewStatus!: string;
  @IsOptional() @IsIn(['UNKNOWN', 'AUTHORIZED', 'UNAUTHORIZED']) authorizationStatus?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** An administrator-created charge (e.g. a damage charge referencing a finding). */
export class CreateChargeDto {
  @IsOptional() @IsString() @MaxLength(60) chargeCode?: string;
  @IsString() @MinLength(1) @MaxLength(300) description!: string;
  @IsOptional() @IsUUID() propertyAreaId?: string;
  @IsOptional() @IsUUID() findingId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) quantity?: number;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  unitAmount!: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** A human decision on a proposed charge (spec §14). AI never reaches this. */
export class ChargeReviewDto {
  @IsIn(['APPROVE', 'REJECT', 'ADJUST', 'WAIVE']) decision!: string;
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  approvedAmount?: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class FindingReviewDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class CreateReportShareDto {
  @IsOptional() @IsEmail() @MaxLength(320) recipientEmail?: string;
}

/**
 * How an imported report is written onto its inspection.
 *
 * Defaults to REPLACE, which is what every existing client sends by omitting
 * it. ADD is for the second report an agent issues when the first walkthrough
 * was incomplete: it writes the areas that report covers and leaves the rest of
 * the inspection alone.
 */
export class CommitInspectionImportDto {
  @IsOptional() @IsIn(['REPLACE', 'ADD']) mode?: 'REPLACE' | 'ADD';
}

export class TestMailDto {
  @IsEmail() @MaxLength(320) recipientEmail!: string;
}

export class FindingRejectDto {
  @IsString() @MinLength(2) @MaxLength(1000) reason!: string;
}

export class AdminFindingsQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['PENDING_REVIEW', 'APPROVED', 'EDITED', 'REJECTED', 'REINSPECTION_REQUESTED'])
  reviewStatus?: string;
  // DEFECTS = chargeable review queue; SUMMARIES = informational room summaries.
  @IsOptional() @IsIn(['ALL', 'DEFECTS', 'SUMMARIES']) kind?: 'ALL' | 'DEFECTS' | 'SUMMARIES';
}

export class AssignmentDto {
  @IsUUID() technicianId!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsString() @MaxLength(120) idempotencyKey?: string;
}

export class UnassignDto {
  @IsString() @MinLength(2) @MaxLength(500) reason!: string;
}

export class AssignmentListQueryDto extends PaginationDto {
  @IsOptional() @IsUUID() inspectionId?: string;
  /**
   * Which kind of visit these assignments are for.
   *
   * Strict `@IsEnum`, matching the inspection list rather than the loose
   * `@IsIn` the assignment statuses use: an unrecognised type is a mistake
   * worth a 400, not a filter that silently does nothing and returns the whole
   * list looking like a section.
   */
  @IsOptional() @IsEnum(InspectionType) inspectionType?: InspectionType;
  @IsOptional() @IsUUID() technicianId?: string;
  @IsOptional() @IsUUID() propertyId?: string;
  @IsOptional()
  @IsIn([
    'SCHEDULED',
    'IN_PROGRESS',
    'TECHNICIAN_SUBMITTED',
    'PROCESSING',
    'REVIEW_REQUIRED',
    'UNDER_REVIEW',
    'TBD',
    'FOLLOW_UP_REQUIRED',
    'COMPLETED',
    'CANCELLED',
  ])
  inspectionStatus?: string;
  @IsOptional() @IsIn(['ASSIGNED', 'REASSIGNED', 'UNASSIGNED']) assignmentStatus?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(['true', 'false']) includeUnassigned?: string;
  /**
   * Include assignments that have been superseded or ended.
   *
   * Off by default, so "assignments" means the ones that are actually in force.
   * The endpoint used to return every row ever written, which is right for the
   * history panel on an inspection and wrong everywhere else — after a
   * reassignment the work list showed the previous technician alongside the
   * current one, while the mobile app showed only the current one, and the two
   * appeared not to agree.
   */
  @IsOptional() @IsIn(['true', 'false']) includeSuperseded?: string;
}

export class AuditListQueryDto extends PaginationDto {}

export class TechnicianListQueryDto extends PaginationDto {
  @IsOptional() @IsIn(['true', 'false']) active?: string;
}

export class TechnicianStatusDto {
  @IsBoolean() isActive!: boolean;
}

export class UpdateAiRoutingDto {
  @IsEnum(AiProvider) activeProvider!: AiProvider;
}

export class UpdateAiProviderDto {
  @IsString() @MinLength(2) @MaxLength(120) modelId!: string;
  @IsOptional() @IsString() @MinLength(20) @MaxLength(500) apiKey?: string;
  @IsOptional() @IsBoolean() clearApiKey?: boolean;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  @Max(2_000_000_000)
  monthlyTokenBudget?: number | null;
}

export class CreateTechnicianDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(2) @MaxLength(120) displayName!: string;
}

export class CreatePropertyAreaDto {
  @IsOptional() @IsUUID() unitId?: string;
  @IsString() @MinLength(1) @MaxLength(80) floorName!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(500) inspectionOrder!: number;
  @IsBoolean() isRequired!: boolean;
  /** Optional here, unlike `isRequired`: absent means no, which is the default. */
  @IsOptional() @IsEnum(AreaEnvironment) environment?: AreaEnvironment;
  @IsOptional() @IsEnum(AreaCategory) category?: AreaCategory;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/** Upper bound on keywords per item — a guard against a pasted wall of text. */
const MAX_CHECKLIST_KEYWORDS = 25;

export class CreateAreaChecklistItemDto {
  @IsString() @MinLength(1) @MaxLength(200) label!: string;
  /**
   * Spoken words that count as covering this item.
   *
   * Lowercased and de-duplicated on write so matching never depends on how an
   * administrator happened to type them, and so the same word twice does not
   * read as two ways to satisfy the item.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CHECKLIST_KEYWORDS)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  keywords?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(500) sortOrder?: number;
}

export class UpdateAreaChecklistItemDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) label?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CHECKLIST_KEYWORDS)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  keywords?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(500) sortOrder?: number;
}

export class UploadFloorPlanDto {
  @IsOptional() @IsUUID() unitId?: string;
}

export class UpdatePropertyAreaDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) floorName?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) inspectionOrder?: number;
  @IsOptional() @IsBoolean() isRequired?: boolean;
  /**
   * Whether this area holds air-conditioning equipment.
   *
   * Scheduling scope, not a condition observation: an HVAC inspection covers
   * every area where this is true, so it is the office saying where the units
   * are rather than a technician reporting what they found.
   */
  @IsOptional() @IsEnum(AreaEnvironment) environment?: AreaEnvironment;
  @IsOptional() @IsEnum(AreaCategory) category?: AreaCategory;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsDateString() expectedUpdatedAt?: string;
}

export class RejectPropertyAreaDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** Place or adjust an area's spatial marker (normalized 0..1). */
export class UpdateAreaMarkerDto {
  @Type(() => Number) @IsNumber() @Min(0) @Max(1) x!: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1) y!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) pageNumber?: number;
  @IsOptional() @IsDateString() expectedUpdatedAt?: string;
}

export class ApprovePropertyAreasDto {
  @ArrayMinSize(1) @IsUUID('4', { each: true }) areaIds!: string[];
}

export class DeletePropertyAreasDto {
  @ArrayMinSize(1) @IsUUID('4', { each: true }) areaIds!: string[];
}

/**
 * Bulk inspection deletion. POST-with-body rather than DELETE, matching
 * `DeletePropertyAreasDto` above — a DELETE carrying a body is poorly supported
 * by proxies and by `fetch`.
 */
export class DeleteInspectionsDto {
  @ArrayMinSize(1) @IsUUID('4', { each: true }) inspectionIds!: string[];
}

/**
 * How one checklist item was found, recorded by a reviewer.
 *
 * Each axis is tri-state: true, false, or omitted for not assessed. Omitted is
 * not the same as false — the report prints an unassessed cell blank precisely
 * so a skipped item cannot be read as a fault.
 */
export class AdminChecklistAssessmentDto {
  /** Seconds into the area's recording, when the answer refers to a moment. */
  @IsOptional() @IsInt() @Min(0) @Max(86_400) videoTimestampSeconds?: number | null;
  @IsOptional() @IsBoolean() isClean?: boolean | null;
  @IsOptional() @IsBoolean() isUndamaged?: boolean | null;
  @IsOptional() @IsBoolean() isWorking?: boolean | null;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string | null;
}

/**
 * A capability the office can grant a technician.
 *
 * The key is a slug and is fixed once created -- it is what an audit row and
 * an import both read, so a key that means one thing in June and another in
 * September makes both unreadable. Retire the skill and add a new one.
 */
export class TechnicianSkillDto {
  @IsString() @MinLength(2) @MaxLength(60) key!: string;
  @IsString() @MinLength(2) @MaxLength(80) label!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class UpdateTechnicianSkillDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) label?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class GrantTechnicianSkillDto {
  @IsUUID() skillId!: string;
  /**
   * The last day the skill counts, or omitted when it does not lapse.
   *
   * A date rather than a timestamp, to match `Inspection.scheduledAt`:
   * scheduling asks whether somebody is qualified on the day of a visit, and a
   * clock time would make that question answerable differently depending on
   * which hour of that day it was asked.
   */
  @IsOptional() @IsDateString() expiresAt?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class RevokeTechnicianSkillDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class SetSkillRequirementDto {
  @IsEnum(InspectionType) inspectionType!: InspectionType;
  @IsUUID() skillId!: string;
  @IsEnum(SkillRequirementLevel) requirement!: SkillRequirementLevel;
}

export class SkillCatalogQueryDto {
  @IsOptional() @IsIn(['true', 'false']) includeInactive?: string;
}
