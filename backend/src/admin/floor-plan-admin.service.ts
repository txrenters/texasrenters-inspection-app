import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { checklistTemplateFor, classifyAreaByName, keywordsFromLabel } from '@texasrenters/shared';
import { FloorPlanStatus, PropertyAreaStatus } from '@prisma/client';
import type { AreaCategory, AreaEnvironment, Prisma } from '@prisma/client';
import type { AdminFloorPlanExtractionSummary } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import type {
  CreateAreaChecklistItemDto,
  CreatePropertyAreaDto,
  UpdateAreaChecklistItemDto,
  UpdateAreaMarkerDto,
  UpdatePropertyAreaDto,
} from './admin.dto';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { AreaChecklistAiService } from './area-checklist-ai.service';
import { FloorPlanExtractionService } from './floor-plan-extraction.service';
import { FloorPlanStorageService } from './floor-plan-storage.service';

export interface UploadedFloorPlan {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

/**
 * A RUNNING extraction older than this was abandoned — almost always a process
 * restart mid-call. Generous enough for a complex multi-storey plan, short
 * enough that an operator is not left watching a spinner that will never end.
 */
const EXTRACTION_STALE_AFTER_MS = 10 * 60 * 1000;

const floorPlanResponseSelect = {
  id: true,
  propertyId: true,
  unitId: true,
  unit: { select: { id: true, name: true } },
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  extractionJobs: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      floorPlanId: true,
      status: true,
      provider: true,
      modelId: true,
      schemaVersion: true,
      errorCode: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.PropertyFloorPlanSelect;

const propertyAreaResponseSelect = {
  id: true,
  propertyId: true,
  unitId: true,
  unit: { select: { id: true, name: true } },
  name: true,
  inspectionOrder: true,
  isRequired: true,
  hasAirConditioning: true,
  status: true,
  source: true,
  environment: true,
  category: true,
  notes: true,
  archivedAt: true,
  markerX: true,
  markerY: true,
  markerSource: true,
  markerConfidence: true,
  markerUpdatedAt: true,
  sourceFloorPlanId: true,
  sourcePageNumber: true,
  boundingBoxX: true,
  boundingBoxY: true,
  boundingBoxWidth: true,
  boundingBoxHeight: true,
  updatedAt: true,
  createdBy: { select: { id: true, displayName: true } },
  floor: { select: { id: true, name: true, sortOrder: true } },
  // checklistItems lets a caller see whether an area has a coverage checklist
  // without fetching one per area. Scheduling is the moment that matters: an
  // administrator is deciding what a technician will be asked to cover, and
  // the checklist lives on another screen entirely.
  _count: {
    select: { inspectionAreas: true, checklistItems: { where: { archivedAt: null } } },
  },
} satisfies Prisma.PropertyAreaSelect;

type PropertyAreaRow = Prisma.PropertyAreaGetPayload<{ select: typeof propertyAreaResponseSelect }>;

/** Case/whitespace-insensitive identity for an area within a plan. */
function areaKey(floorName: string, name: string) {
  return `${floorName.trim().toLowerCase()}|${name.trim().toLowerCase()}`;
}

// Nullish-safe: a column may arrive as null (Prisma) or undefined (partial row).
function num(value: Prisma.Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Shapes a selected area row into the web DTO. Decimal coordinates become plain
 * numbers, and marker/bounding-box columns collapse into nested objects. Raw AI
 * payloads/prompts/provider settings are never part of this row, so nothing
 * sensitive is exposed.
 */
function mapArea(row: PropertyAreaRow) {
  const markerX = num(row.markerX);
  const markerY = num(row.markerY);
  const hasMarker = markerX !== null && markerY !== null;
  const bboxX = num(row.boundingBoxX);
  const bboxY = num(row.boundingBoxY);
  const bboxWidth = num(row.boundingBoxWidth);
  const bboxHeight = num(row.boundingBoxHeight);
  const bbox =
    bboxX !== null && bboxY !== null && bboxWidth !== null && bboxHeight !== null
      ? { x: bboxX, y: bboxY, width: bboxWidth, height: bboxHeight }
      : null;
  return {
    id: row.id,
    propertyId: row.propertyId,
    updatedAt: row.updatedAt,
    unitId: row.unitId,
    unit: row.unit,
    name: row.name,
    inspectionOrder: row.inspectionOrder,
    isRequired: row.isRequired,
    hasAirConditioning: row.hasAirConditioning,
    status: row.status,
    source: row.source,
    environment: row.environment,
    category: row.category,
    notes: row.notes,
    archivedAt: row.archivedAt,
    createdBy: row.createdBy,
    floor: row.floor,
    _count: row._count,
    sourceFloorPlanId: row.sourceFloorPlanId,
    sourcePageNumber: row.sourcePageNumber,
    marker: hasMarker
      ? {
          available: true as const,
          x: markerX,
          y: markerY,
          source: row.markerSource ?? null,
          confidence: num(row.markerConfidence),
          updatedAt: row.markerUpdatedAt ?? null,
        }
      : null,
    boundingBox: bbox,
  };
}

/**
 * Lowercased, trimmed and de-duplicated.
 *
 * Matching must not depend on how an administrator happened to type a word, and
 * the same keyword twice does not mean two ways to satisfy an item.
 */
function normalizeKeywords(keywords: string[] | undefined): string[] {
  if (!keywords?.length) return [];
  return [...new Set(keywords.map((word) => word.trim().toLowerCase()).filter(Boolean))];
}

// keywordsFromLabel now lives in @texasrenters/shared, beside the checklist
// template that generates labels, so generated and hand-written items derive
// their keywords identically.
@Injectable()
export class FloorPlanAdminService {
  private readonly logger = new Logger(FloorPlanAdminService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FloorPlanStorageService) private readonly storage: FloorPlanStorageService,
    @Inject(FloorPlanExtractionService) private readonly extraction: FloorPlanExtractionService,
    @Inject(AreaChecklistAiService) private readonly checklistAi: AreaChecklistAiService,
    @Inject(AiProviderSettingsService) private readonly aiSettings: AiProviderSettingsService,
  ) {}

  async list(user: AuthenticatedUser, buildingId: string) {
    await this.requireBuilding(user.organizationId, buildingId);
    const property = await this.prisma.property.findUnique({
      where: { id: buildingId },
      select: { id: true },
    });
    if (!property) return [];
    return this.prisma.propertyFloorPlan.findMany({
      where: { propertyId: buildingId },
      select: floorPlanResponseSelect,
      orderBy: { createdAt: 'desc' },
    });
  }

  async upload(
    user: AuthenticatedUser,
    buildingId: string,
    file?: UploadedFloorPlan,
    unitId?: string,
  ) {
    const building = await this.requireBuilding(user.organizationId, buildingId, true);
    if (!file)
      throw new ApplicationError(422, 'FLOOR_PLAN_FILE_REQUIRED', 'Select a floor-plan file.');
    this.validateFile(file);
    if (unitId) await this.requireUnit(user.organizationId, buildingId, unitId);
    await this.ensureProperty(building);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-140);
    const id = randomUUID();
    const storageKey = `${user.organizationId}/${buildingId}/${id}/${safeName}`;
    await this.storage.put(storageKey, file.buffer, file.mimetype);
    try {
      const plan = await this.prisma.propertyFloorPlan.create({
        data: {
          id,
          propertyId: buildingId,
          unitId: unitId ?? null,
          fileName: safeName,
          mimeType: file.mimetype,
          storageKey,
          sizeBytes: file.size,
        },
        select: floorPlanResponseSelect,
      });
      await this.audit(user, 'FLOOR_PLAN_UPLOADED', 'PropertyFloorPlan', plan.id, {
        propertywareBuildingId: buildingId,
        unitId: unitId ?? null,
        mimeType: file.mimetype,
        sizeBytes: file.size,
      });
      return plan;
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async content(user: AuthenticatedUser, floorPlanId: string) {
    const plan = await this.requirePlan(user.organizationId, floorPlanId);
    return {
      bytes: await this.storage.get(plan.storageKey),
      fileName: plan.fileName,
      mimeType: plan.mimeType,
    };
  }

  /**
   * Starts extraction and returns immediately with the job to poll.
   *
   * The model call takes tens of seconds on a simple plan and grows with plan
   * complexity, while the HTTP server closes idle sockets after
   * HTTP_REQUEST_TIMEOUT_MS. Running it inside the request meant the socket was
   * destroyed mid-flight — the browser saw ERR_EMPTY_RESPONSE while the handler
   * ran to completion and logged success, so nothing appeared in the error
   * logs. No timeout value fixes that for arbitrarily complex plans; the work
   * has to leave the request.
   */
  async extract(user: AuthenticatedUser, floorPlanId: string) {
    const plan = await this.requirePlan(user.organizationId, floorPlanId);
    const configuration = await this.aiSettings.resolve(user.organizationId);
    const descriptor = this.extraction.descriptor(configuration);
    // One extraction per plan at a time: a second run would race the first
    // over the same draft areas. A job abandoned by a restart is not counted.
    const active = await this.prisma.floorPlanExtractionJob.findFirst({
      where: { floorPlanId, status: 'RUNNING' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, updatedAt: true },
    });
    if (active && !this.isStaleJob(active.updatedAt))
      throw new ApplicationError(
        409,
        'EXTRACTION_ALREADY_RUNNING',
        'An extraction is already running for this plan.',
      );
    const job = await this.prisma.floorPlanExtractionJob.create({
      data: { floorPlanId, status: 'RUNNING', ...descriptor },
    });
    await this.prisma.propertyFloorPlan.update({
      where: { id: floorPlanId },
      data: { status: FloorPlanStatus.PROCESSING },
    });
    // Deliberately not awaited: the caller polls extractionJob() instead.
    // runExtraction records its own outcome and never rejects.
    void this.runExtraction(user, plan, configuration, job.id);
    return { jobId: job.id, status: 'RUNNING' as const };
  }

  /** A RUNNING job older than this was abandoned by a process restart. */
  private isStaleJob(updatedAt: Date) {
    return Date.now() - updatedAt.getTime() > EXTRACTION_STALE_AFTER_MS;
  }

  /**
   * Status for a running or finished extraction. Self-heals a job abandoned
   * mid-flight: without this a restart would leave the plan PROCESSING and the
   * UI polling forever.
   */
  async extractionJob(user: AuthenticatedUser, floorPlanId: string, jobId: string) {
    await this.requirePlan(user.organizationId, floorPlanId);
    const job = await this.prisma.floorPlanExtractionJob.findFirst({
      where: { id: jobId, floorPlanId },
      select: { id: true, status: true, errorCode: true, output: true, updatedAt: true },
    });
    if (!job)
      throw new ApplicationError(404, 'EXTRACTION_JOB_NOT_FOUND', 'Extraction job was not found.');
    if (job.status === 'RUNNING' && this.isStaleJob(job.updatedAt)) {
      await Promise.allSettled([
        this.prisma.floorPlanExtractionJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', errorCode: 'FLOOR_PLAN_EXTRACTION_TIMED_OUT' },
        }),
        this.prisma.propertyFloorPlan.update({
          where: { id: floorPlanId },
          data: { status: FloorPlanStatus.FAILED },
        }),
      ]);
      return {
        id: job.id,
        status: 'FAILED' as const,
        errorCode: 'FLOOR_PLAN_EXTRACTION_TIMED_OUT',
        summary: null,
      };
    }
    const output = job.output as { summary?: AdminFloorPlanExtractionSummary } | null;
    return {
      id: job.id,
      status: job.status,
      errorCode: job.errorCode,
      summary: output?.summary ?? null,
    };
  }

  private async runExtraction(
    user: AuthenticatedUser,
    plan: Awaited<ReturnType<FloorPlanAdminService['requirePlan']>>,
    configuration: Awaited<ReturnType<AiProviderSettingsService['resolve']>>,
    jobId: string,
  ) {
    const floorPlanId = plan.id;
    const job = { id: jobId };
    try {
      const extractionResult = await this.extraction.extract(
        await this.storage.get(plan.storageKey),
        plan.mimeType,
        configuration,
      );
      const extracted = extractionResult.areas;
      /**
       * Checklists are generated here, **before** the transaction opens.
       *
       * A provider call can take the better part of a minute; inside the
       * transaction it would hold it open far past the pooler's limit and
       * surface as "Transaction not found" — losing the extraction, not just
       * the checklists.
       *
       * Generated for every extracted area, including ones the transaction
       * later discards as duplicates. That wastes a few tokens and keeps this
       * independent of a decision that needs the database to make.
       */
      const generatedChecklists = await this.checklistAi.generate(
        extracted.map((area) => {
          const classified = classifyAreaByName(area.name);
          return {
            name: area.name,
            category: classified.category,
            environment: classified.environment,
          };
        }),
        configuration,
      );
      const checklistByArea = new Map(
        extracted.map((area, index) => [area, generatedChecklists.items[index] ?? []]),
      );
      // The database can be several hundred milliseconds away (hosted
      // Supabase), so the transaction batches its work into a constant number
      // of round trips regardless of how many rooms were extracted, and runs
      // with an explicit timeout instead of Prisma's 5-second default.
      const result = await this.prisma.$transaction(
        async (tx) => {
          // All extraction bookkeeping is scoped to the plan's unit: a unit
          // plan only replaces/collides with that unit's areas, and a
          // building-level plan only with building-level areas.
          await tx.propertyArea.deleteMany({
            where: {
              propertyId: plan.propertyId,
              unitId: plan.unitId,
              status: PropertyAreaStatus.DRAFT,
              source: 'AI_FLOOR_PLAN',
              inspectionAreas: { none: {} },
            },
          });
          const existing = await tx.propertyArea.findMany({
            where: { propertyId: plan.propertyId, unitId: plan.unitId },
            select: {
              name: true,
              inspectionOrder: true,
              floor: { select: { name: true } },
            },
          });
          const seen = new Set(
            existing.map((area) => areaKey(area.floor?.name || 'Ground Floor', area.name)),
          );
          const usedOrders = new Set(existing.map((area) => area.inspectionOrder));
          let nextAvailableOrder =
            existing.reduce((highest, area) => Math.max(highest, area.inspectionOrder), 0) + 1;
          const reserveOrder = (preferred: number) => {
            if (!usedOrders.has(preferred)) {
              usedOrders.add(preferred);
              return preferred;
            }
            while (usedOrders.has(nextAvailableOrder)) nextAvailableOrder += 1;
            const reserved = nextAvailableOrder;
            usedOrders.add(reserved);
            nextAvailableOrder += 1;
            return reserved;
          };
          const fresh: typeof extracted = [];
          const skipped: Array<{ floorName: string; name: string }> = [];
          for (const suggestion of extracted) {
            const key = areaKey(suggestion.floorName, suggestion.name);
            if (seen.has(key)) {
              skipped.push({ floorName: suggestion.floorName, name: suggestion.name });
              continue;
            }
            seen.add(key);
            fresh.push({
              ...suggestion,
              inspectionOrder: reserveOrder(suggestion.inspectionOrder),
            });
          }
          // Resolve all floors in one read; create only the missing ones.
          const floors = await tx.propertyFloor.findMany({
            where: { propertyId: plan.propertyId, unitId: plan.unitId },
            select: { id: true, name: true },
          });
          const floorIdByName = new Map(
            floors.map((floor) => [floor.name.trim().toLowerCase(), floor.id]),
          );
          for (const suggestion of fresh) {
            const floorKey = suggestion.floorName.trim().toLowerCase();
            if (floorIdByName.has(floorKey)) continue;
            const floor = await tx.propertyFloor.create({
              data: {
                propertyId: plan.propertyId,
                unitId: plan.unitId,
                name: suggestion.floorName,
                sortOrder: suggestion.inspectionOrder,
              },
              select: { id: true },
            });
            floorIdByName.set(floorKey, floor.id);
          }
          // Insert every area in one statement with pre-assigned ids, then
          // load them back with the full response shape in one more read.
          const areaRows = fresh.map((suggestion) => {
            // The model returns a name and no classification, so without this
            // every area took the schema default of INDOOR with no category —
            // a patio stored as an indoor room, and later handed the indoor
            // checklist, down to "walls and ceilings".
            const classified = classifyAreaByName(suggestion.name);
            return {
            id: randomUUID(),
            propertyId: plan.propertyId,
            unitId: plan.unitId,
            floorId: floorIdByName.get(suggestion.floorName.trim().toLowerCase())!,
            name: suggestion.name,
            inspectionOrder: suggestion.inspectionOrder,
            isRequired: suggestion.isRequired,
            source: 'AI_FLOOR_PLAN',
            status: PropertyAreaStatus.DRAFT,
            environment: classified.environment as AreaEnvironment,
            category: classified.category as AreaCategory,
            // Spatial marker (if the model returned a valid one), tied to THIS plan
            // version so a replaced plan never silently reuses old coordinates.
            markerX: suggestion.marker?.x ?? null,
            markerY: suggestion.marker?.y ?? null,
            markerSource: suggestion.marker ? 'AI_EXTRACTED' : null,
            markerConfidence: suggestion.marker?.confidence ?? null,
            boundingBoxX: suggestion.boundingBox?.x ?? null,
            boundingBoxY: suggestion.boundingBox?.y ?? null,
            boundingBoxWidth: suggestion.boundingBox?.width ?? null,
            boundingBoxHeight: suggestion.boundingBox?.height ?? null,
              sourceFloorPlanId: floorPlanId,
            };
          });
          if (areaRows.length) await tx.propertyArea.createMany({ data: areaRows });
          // The checklist is part of what extraction produces, not a surprise
          // that appears on approval. Generating it here puts the proposed
          // items in front of the reviewer while the areas are still drafts,
          // which is the only point at which changing them is cheap.
          //
          // Approval still generates for anything that has none — areas
          // extracted before this, and drafts added by hand — and its
          // "already has a checklist" guard means these are not duplicated.
          const checklistRows = areaRows.flatMap((row, rowIndex) => {
            // areaRows is fresh.map(...), so index i is fresh[i]. Matching on
            // the object rather than the name matters: three areas called
            // "Living area" is normal here, and a name lookup would give all
            // three whichever list came back first.
            const labels = checklistByArea.get(fresh[rowIndex]!);
            return (
              labels?.length
                ? labels
                : checklistTemplateFor({
                    name: row.name,
                    category: row.category,
                    environment: row.environment,
                  })
            ).map((label, index) => ({
              organizationId: user.organizationId,
              propertyAreaId: row.id,
              label,
              keywords: keywordsFromLabel(label),
              sortOrder: index,
              createdById: user.id,
            }));
          });
          if (checklistRows.length) await tx.areaChecklistItem.createMany({ data: checklistRows });
          const created = areaRows.length
            ? await tx.propertyArea.findMany({
                where: { id: { in: areaRows.map((row) => row.id) } },
                select: propertyAreaResponseSelect,
                orderBy: { inspectionOrder: 'asc' },
              })
            : [];
          const summary = {
            detectedCount: extracted.length,
            createdCount: created.length,
            alreadyPresentCount: skipped.length,
            // Areas whose marker was missing or invalid (mapping warning, §5).
            markerWarnings: fresh.filter((suggestion) => !suggestion.marker).length,
          };
          const output = {
            suggestions: extracted,
            createdAreaIds: created.map((area) => area.id),
            skipped,
            summary,
          };
          await tx.floorPlanExtractionJob.update({
            where: { id: job.id },
            data: { status: 'COMPLETED', output },
          });
          await tx.propertyFloorPlan.update({
            where: { id: floorPlanId },
            data: { status: FloorPlanStatus.REVIEW_REQUIRED },
          });
          return { ...job, status: 'COMPLETED', output, summary, areas: created.map(mapArea) };
        },
        { maxWait: 10_000, timeout: 60_000 },
      );
      await this.audit(user, 'FLOOR_PLAN_EXTRACTED', 'PropertyFloorPlan', floorPlanId, {
        jobId: job.id,
        detectedAreaCount: result.summary.detectedCount,
        draftAreaCount: result.areas.length,
        existingAreaCount: result.summary.alreadyPresentCount,
      });
      await this.aiSettings
        .recordUsage(
          user.organizationId,
          configuration,
          'FLOOR_PLAN_EXTRACTION',
          extractionResult.usage,
          job.id,
        )
        .catch(() => undefined);
      return result;
    } catch (error) {
      const code = error instanceof ApplicationError ? error.code : 'FLOOR_PLAN_EXTRACTION_FAILED';
      // Failure bookkeeping must never replace the safe, actionable provider error.
      // A transient database failure here previously surfaced as a generic HTTP 500.
      await Promise.allSettled([
        this.prisma.floorPlanExtractionJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', errorCode: code },
        }),
        this.prisma.propertyFloorPlan.update({
          where: { id: floorPlanId },
          data: { status: FloorPlanStatus.FAILED },
        }),
      ]);
      // Nothing is awaiting this call, so the error is recorded on the job and
      // deliberately not rethrown — an unhandled rejection would take the
      // process down and tell the operator nothing.
      this.logger.error(
        `Floor plan extraction ${jobId} failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return undefined;
    }
  }

  /**
   * Backfills spatial markers for areas that already exist without coordinates —
   * typically extracted before marker support (schema v1). Re-runs extraction and
   * matches suggestions to existing areas by floor + name, writing **only**
   * marker/bounding-box columns. Names, order, required flags, and approval
   * status are never modified, and areas that already have a marker for this plan
   * are left untouched.
   */
  async retryMissingMarkers(user: AuthenticatedUser, floorPlanId: string) {
    const plan = await this.requirePlan(user.organizationId, floorPlanId);
    const candidates = await this.prisma.propertyArea.findMany({
      where: {
        propertyId: plan.propertyId,
        unitId: plan.unitId,
        archivedAt: null,
        OR: [{ markerX: null }, { markerY: null }, { sourceFloorPlanId: { not: floorPlanId } }],
      },
      select: { id: true, name: true, floor: { select: { name: true } } },
    });
    if (!candidates.length)
      return { matched: 0, updated: 0, unmatched: 0, areas: await this.areas(user, plan.propertyId) };

    const configuration = await this.aiSettings.resolve(user.organizationId);
    const extractionResult = await this.extraction.extract(
      await this.storage.get(plan.storageKey),
      plan.mimeType,
      configuration,
    );
    const suggestionByKey = new Map(
      extractionResult.areas
        .filter((suggestion) => suggestion.marker)
        .map((suggestion) => [areaKey(suggestion.floorName, suggestion.name), suggestion]),
    );

    let updated = 0;
    for (const area of candidates) {
      const suggestion = suggestionByKey.get(areaKey(area.floor?.name || 'Ground Floor', area.name));
      if (!suggestion?.marker) continue;
      await this.prisma.propertyArea.update({
        where: { id: area.id },
        data: {
          markerX: suggestion.marker.x,
          markerY: suggestion.marker.y,
          markerSource: 'AI_EXTRACTED',
          markerConfidence: suggestion.marker.confidence ?? null,
          boundingBoxX: suggestion.boundingBox?.x ?? null,
          boundingBoxY: suggestion.boundingBox?.y ?? null,
          boundingBoxWidth: suggestion.boundingBox?.width ?? null,
          boundingBoxHeight: suggestion.boundingBox?.height ?? null,
          sourceFloorPlanId: floorPlanId,
          // NOTE: name, inspectionOrder, isRequired and status are never written.
        },
      });
      updated += 1;
    }
    await this.audit(user, 'AREA_MARKER_GENERATED', 'PropertyFloorPlan', floorPlanId, {
      candidateCount: candidates.length,
      updated,
      unmatched: candidates.length - updated,
    });
    await this.aiSettings
      .recordUsage(
        user.organizationId,
        configuration,
        'FLOOR_PLAN_EXTRACTION',
        extractionResult.usage,
        floorPlanId,
      )
      .catch(() => undefined);
    return {
      matched: updated,
      updated,
      unmatched: candidates.length - updated,
      areas: await this.areas(user, plan.propertyId),
    };
  }

  async areas(user: AuthenticatedUser, buildingId: string) {
    await this.requireBuilding(user.organizationId, buildingId);
    const rows = await this.prisma.propertyArea.findMany({
      // Archived areas are hidden from the active list but retain their media.
      where: { propertyId: buildingId, archivedAt: null },
      select: propertyAreaResponseSelect,
      orderBy: [{ inspectionOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(mapArea);
  }

  async createArea(user: AuthenticatedUser, buildingId: string, input: CreatePropertyAreaDto) {
    const building = await this.requireBuilding(user.organizationId, buildingId, true);
    const unitId = input.unitId ?? null;
    if (unitId) await this.requireUnit(user.organizationId, buildingId, unitId);
    await this.ensureProperty(building);
    await this.assertUniqueArea(buildingId, unitId, input.floorName, input.name);
    const floor = await this.findOrCreateFloor(
      buildingId,
      unitId,
      input.floorName,
      input.inspectionOrder,
    );
    const area = await this.prisma.propertyArea.create({
      data: {
        propertyId: buildingId,
        unitId,
        floorId: floor.id,
        name: input.name.trim(),
        inspectionOrder: input.inspectionOrder,
        isRequired: input.isRequired,
        hasAirConditioning: input.hasAirConditioning ?? false,
        source: 'MANUAL',
        status: PropertyAreaStatus.DRAFT,
        createdById: user.id,
        ...(input.environment ? { environment: input.environment } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      },
      select: propertyAreaResponseSelect,
    });
    await this.audit(user, 'PROPERTY_AREA_CREATED', 'PropertyArea', area.id, {
      propertywareBuildingId: buildingId,
      unitId,
    });
    return mapArea(area);
  }

  async createFallbackArea(user: AuthenticatedUser, buildingId: string) {
    const building = await this.requireBuilding(user.organizationId, buildingId, true);
    await this.ensureProperty(building);
    const floor = await this.findOrCreateFloor(buildingId, null, 'Whole property', 1);

    return this.prisma.$transaction(async (tx) => {
      const approved = await tx.propertyArea.findFirst({
        where: { propertyId: buildingId, status: PropertyAreaStatus.APPROVED },
        select: propertyAreaResponseSelect,
      });
      if (approved) return mapArea(approved);

      const existing = await tx.propertyArea.findFirst({
        where: {
          propertyId: buildingId,
          floorId: floor.id,
          name: { equals: 'Entire property', mode: 'insensitive' },
        },
        select: { id: true },
      });
      const area = existing
        ? await tx.propertyArea.update({
            where: { id: existing.id },
            data: {
              inspectionOrder: 1,
              isRequired: true,
              source: 'MANUAL_FALLBACK',
              status: PropertyAreaStatus.APPROVED,
            },
            select: propertyAreaResponseSelect,
          })
        : await tx.propertyArea.create({
            data: {
              propertyId: buildingId,
              floorId: floor.id,
              name: 'Entire property',
              inspectionOrder: 1,
              isRequired: true,
              source: 'MANUAL_FALLBACK',
              status: PropertyAreaStatus.APPROVED,
            },
            select: propertyAreaResponseSelect,
          });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'PROPERTY_FALLBACK_AREA_APPROVED',
          entityType: 'PropertywareBuilding',
          entityId: buildingId,
          metadata: { areaId: area.id, reason: 'FLOOR_PLAN_AREAS_UNAVAILABLE' },
        },
      });
      return mapArea(area);
    });
  }

  /**
   * Whether any finalized inspection already refers to this area.
   *
   * Keyed on `finalizedAt` rather than status === COMPLETED. An administrator
   * can reopen a finalized inspection to IN_PROGRESS, and a status-only check
   * would let the area be renamed while it is reopened — relabelling evidence
   * in a report that was already finished, permanently, since the rename
   * survives re-finalization. Having been finalized once is what freezes it.
   */
  private async areaIsFinalized(areaId: string) {
    const finalized = await this.prisma.inspectionArea.count({
      where: { propertyAreaId: areaId, inspection: { finalizedAt: { not: null } } },
    });
    return finalized > 0;
  }

  async updateArea(user: AuthenticatedUser, areaId: string, input: UpdatePropertyAreaDto) {
    const area = await this.requireArea(user.organizationId, areaId);
    this.assertExpectedAreaRevision(area.updatedAt, input.expectedUpdatedAt);
    // Approved areas are frozen so a property's layout cannot shift under
    // inspections that are already using it. A technician-added area is the
    // exception: it is approved on creation precisely because nobody reviewed
    // it first, so this is the only opportunity anyone gets to correct a name
    // typed one-handed in somebody's back garden.
    //
    // That exception ends once an inspection referencing it has been completed.
    // Renaming an area then would relabel evidence in a finished report, which
    // is the audit trail rather than the layout.
    if (area.status !== PropertyAreaStatus.DRAFT) {
      const correctable = area.source === 'TECHNICIAN' && !(await this.areaIsFinalized(area.id));
      if (!correctable)
        throw new ApplicationError(
          409,
          'AREA_ALREADY_APPROVED',
          area.source === 'TECHNICIAN'
            ? 'This area appears in a completed inspection and can no longer be renamed.'
            : 'Approved areas cannot be edited.',
        );
    }
    const floorName = input.floorName?.trim() || area.floor?.name || 'Ground Floor';
    const name = input.name?.trim() || area.name;
    await this.assertUniqueArea(area.propertyId, area.unitId, floorName, name, area.id);
    const floor = input.floorName
      ? await this.findOrCreateFloor(
          area.propertyId,
          area.unitId,
          floorName,
          input.inspectionOrder ?? area.inspectionOrder,
        )
      : area.floor;
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.propertyArea.updateMany({
        where: {
          id: areaId,
          ...(input.expectedUpdatedAt ? { updatedAt: new Date(input.expectedUpdatedAt) } : {}),
        },
        data: {
          ...(input.name ? { name } : {}),
          ...(input.floorName ? { floorId: floor?.id } : {}),
          ...(input.inspectionOrder ? { inspectionOrder: input.inspectionOrder } : {}),
          ...(input.isRequired === undefined ? {} : { isRequired: input.isRequired }),
          // `=== undefined` rather than truthiness, like isRequired above and
          // unlike the fields below it: false is a meaningful value here, and a
          // truthy check would make unticking an area impossible.
          ...(input.hasAirConditioning === undefined
            ? {}
            : { hasAirConditioning: input.hasAirConditioning }),
          ...(input.environment ? { environment: input.environment } : {}),
          ...(input.category ? { category: input.category } : {}),
          ...(input.notes === undefined ? {} : { notes: input.notes.trim() || null }),
        },
      });
      if (!result.count) {
        const current = await tx.propertyArea.findUnique({
          where: { id: areaId },
          select: { updatedAt: true },
        });
        throw new ApplicationError(
          409,
          'AREA_VERSION_CONFLICT',
          'This area changed after you opened it. Review the latest values and try again.',
          [
            {
              attemptedUpdatedAt: input.expectedUpdatedAt ?? null,
              currentUpdatedAt: current?.updatedAt ?? null,
            },
          ],
        );
      }
      return tx.propertyArea.findUniqueOrThrow({
        where: { id: areaId },
        select: propertyAreaResponseSelect,
      });
    });
    return mapArea(updated);
  }

  /** Rejects a pending area without deleting any evidence already captured. */
  async rejectArea(user: AuthenticatedUser, areaId: string, reason?: string) {
    const area = await this.requireArea(user.organizationId, areaId);
    const updated = await this.prisma.propertyArea.update({
      where: { id: areaId },
      data: { status: PropertyAreaStatus.REJECTED },
      select: propertyAreaResponseSelect,
    });
    await this.audit(user, 'PROPERTY_AREA_REJECTED', 'PropertyArea', areaId, {
      propertywareBuildingId: area.propertyId,
      reason: reason?.trim() || null,
    });
    return mapArea(updated);
  }

  /** Soft-archives an area (hidden from active lists; media/findings retained). */
  async archiveArea(user: AuthenticatedUser, areaId: string) {
    const area = await this.requireArea(user.organizationId, areaId);
    const updated = await this.prisma.propertyArea.update({
      where: { id: areaId },
      data: { archivedAt: new Date() },
      select: propertyAreaResponseSelect,
    });
    await this.audit(user, 'PROPERTY_AREA_ARCHIVED', 'PropertyArea', areaId, {
      propertywareBuildingId: area.propertyId,
    });
    return mapArea(updated);
  }

  /**
   * Places or adjusts an area's spatial marker (normalized 0..1). Marker edits
   * are a DRAFT suggestion an administrator confirms — they never change approval
   * status. Coordinates are stamped with the current plan version so a replaced
   * plan never silently inherits them. Always audited.
   */
  async updateAreaMarker(user: AuthenticatedUser, areaId: string, input: UpdateAreaMarkerDto) {
    const area = await this.requireArea(user.organizationId, areaId);
    this.assertExpectedAreaRevision(area.updatedAt, input.expectedUpdatedAt);
    // Keep the marker's own plan version; for a legacy/manual area with none,
    // bind it to the latest plan in the area's scope so it renders on that plan.
    let sourceFloorPlanId = area.sourceFloorPlanId;
    if (!sourceFloorPlanId) {
      const latestPlan = await this.prisma.propertyFloorPlan.findFirst({
        where: { propertyId: area.propertyId, unitId: area.unitId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      sourceFloorPlanId = latestPlan?.id ?? null;
    }
    const hadMarker = area.markerX !== null && area.markerY !== null;
    const previous = hadMarker ? { x: Number(area.markerX), y: Number(area.markerY) } : null;
    const markerData = {
      markerX: input.x,
      markerY: input.y,
      // Human placement carries no model confidence.
      markerSource: hadMarker ? 'ADMIN_ADJUSTED' : 'ADMIN_PLACED',
      markerConfidence: null,
      markerUpdatedById: user.id,
      markerUpdatedAt: new Date(),
      sourceFloorPlanId,
      ...(input.pageNumber !== undefined ? { sourcePageNumber: input.pageNumber } : {}),
      // NOTE: `status` is intentionally never written here.
    };
    const expectedUpdatedAt = input.expectedUpdatedAt;
    const updated = expectedUpdatedAt
      ? await this.prisma.$transaction(async (tx) => {
      const result = await tx.propertyArea.updateMany({
        where: {
          id: areaId,
          updatedAt: new Date(expectedUpdatedAt),
        },
        data: markerData,
      });
      if (!result.count) {
        const current = await tx.propertyArea.findUnique({
          where: { id: areaId },
          select: { updatedAt: true },
        });
        throw new ApplicationError(
          409,
          'AREA_VERSION_CONFLICT',
          'This marker changed after you opened it. Review the latest position and try again.',
          [
            {
              attemptedUpdatedAt: expectedUpdatedAt,
              currentUpdatedAt: current?.updatedAt ?? null,
            },
          ],
        );
      }
      return tx.propertyArea.findUniqueOrThrow({
        where: { id: areaId },
        select: propertyAreaResponseSelect,
      });
    })
      : await this.prisma.propertyArea.update({
          where: { id: areaId },
          data: markerData,
          select: propertyAreaResponseSelect,
        });
    await this.audit(
      user,
      hadMarker ? 'AREA_MARKER_MOVED' : 'AREA_MARKER_PLACED',
      'PropertyArea',
      areaId,
      {
        propertywareBuildingId: area.propertyId,
        previous,
        next: { x: input.x, y: input.y },
        sourceFloorPlanId,
      },
    );
    return mapArea(updated);
  }

  private assertExpectedAreaRevision(current: Date, expected?: string) {
    if (!expected || current.getTime() === new Date(expected).getTime()) return;
    throw new ApplicationError(
      409,
      'AREA_VERSION_CONFLICT',
      'This area changed after you opened it. Review the latest values and try again.',
      [{ attemptedUpdatedAt: expected, currentUpdatedAt: current }],
    );
  }

  async deleteArea(user: AuthenticatedUser, areaId: string) {
    const area = await this.requireArea(user.organizationId, areaId);
    const uses = await this.prisma.inspectionArea.count({ where: { propertyAreaId: areaId } });
    if (uses)
      throw new ApplicationError(
        409,
        'AREA_IN_USE',
        'An area used by an inspection cannot be deleted.',
      );
    await this.prisma.propertyArea.delete({ where: { id: areaId } });
    await this.audit(user, 'PROPERTY_AREA_DELETED', 'PropertyArea', areaId, {
      propertywareBuildingId: area.propertyId,
    });
    return { id: areaId, deleted: true as const, deletedAt: new Date().toISOString() };
  }

  /**
   * Deletes several areas at once.
   *
   * All-or-nothing: deletion is irreversible, so a batch containing anything
   * protected is refused outright rather than partially applied. The refusal
   * names the offending areas so the operator can deselect them — failing with
   * only a count would leave them guessing which of twenty rows was the problem.
   */
  async deleteAreas(user: AuthenticatedUser, buildingId: string, areaIds: string[]) {
    await this.requireBuilding(user.organizationId, buildingId, true);
    const uniqueIds = [...new Set(areaIds)];
    if (uniqueIds.length !== areaIds.length)
      throw new ApplicationError(
        422,
        'INVALID_AREA_SELECTION',
        'Area selection contains duplicates.',
      );
    const selected = await this.prisma.propertyArea.findMany({
      where: { id: { in: uniqueIds }, propertyId: buildingId },
      select: { id: true, name: true },
    });
    // Anything not found is either outside this building or another
    // organization's; either way it must not be silently skipped.
    if (selected.length !== uniqueIds.length)
      throw new ApplicationError(
        422,
        'INVALID_AREA_SELECTION',
        'Select only areas that belong to this property.',
      );
    const inUse = await this.prisma.inspectionArea.findMany({
      where: { propertyAreaId: { in: uniqueIds } },
      select: { propertyAreaId: true },
      distinct: ['propertyAreaId'],
    });
    if (inUse.length) {
      const blocked = new Set(inUse.map((row) => row.propertyAreaId));
      const names = selected.filter((area) => blocked.has(area.id)).map((area) => area.name);
      throw new ApplicationError(
        409,
        'AREA_IN_USE',
        `${names.length} selected area${names.length === 1 ? '' : 's'} ${
          names.length === 1 ? 'is' : 'are'
        } used by an inspection and cannot be deleted: ${names.join(', ')}.`,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.propertyArea.deleteMany({ where: { id: { in: uniqueIds } } });
      // One audit event per area, matching single deletion, so the trail reads
      // the same however the deletion was performed.
      await tx.auditLog.createMany({
        data: uniqueIds.map((areaId) => ({
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'PROPERTY_AREA_DELETED',
          entityType: 'PropertyArea',
          entityId: areaId,
          metadata: { propertywareBuildingId: buildingId, batch: true },
        })),
      });
    });
    return {
      ids: uniqueIds,
      deleted: uniqueIds.length,
      deletedAt: new Date().toISOString(),
    };
  }

  async approveAreas(user: AuthenticatedUser, buildingId: string, areaIds: string[]) {
    await this.requireBuilding(user.organizationId, buildingId, true);
    const uniqueIds = [...new Set(areaIds)];
    if (uniqueIds.length !== areaIds.length)
      throw new ApplicationError(
        422,
        'INVALID_AREA_SELECTION',
        'Area selection contains duplicates.',
      );
    const selected = await this.prisma.propertyArea.findMany({
      where: { id: { in: uniqueIds }, propertyId: buildingId, status: PropertyAreaStatus.DRAFT },
      // Name, category and environment come back too: approval is where an
      // extracted area gets its default checklist, and the template reads all
      // three to decide which list an area takes.
      select: { id: true, name: true, category: true, environment: true },
    });
    if (selected.length !== uniqueIds.length)
      throw new ApplicationError(
        422,
        'INVALID_AREA_SELECTION',
        'Select only draft areas for this property.',
      );
    // Only areas nobody has written a checklist for. An administrator who
    // authored one before approving has said what this area needs; appending
    // the house standard underneath would duplicate half of it and reorder the
    // rest.
    const alreadyListed = new Set(
      (
        await this.prisma.areaChecklistItem.findMany({
          where: { propertyAreaId: { in: uniqueIds }, archivedAt: null },
          select: { propertyAreaId: true },
          distinct: ['propertyAreaId'],
        })
      ).map((item) => item.propertyAreaId),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.propertyArea.updateMany({
        where: { id: { in: uniqueIds } },
        data: { status: PropertyAreaStatus.APPROVED },
      });
      // Approval is the moment an extracted area becomes part of the property,
      // so it is where the default checklist belongs — the same list a
      // technician-added area gets on creation, from the same table.
      const generated = selected
        .filter((area) => !alreadyListed.has(area.id))
        .flatMap((area) =>
          checklistTemplateFor({
            name: area.name,
            category: area.category,
            environment: area.environment,
          }).map((label, index) => ({
            organizationId: user.organizationId,
            propertyAreaId: area.id,
            label,
            keywords: keywordsFromLabel(label),
            sortOrder: index,
            createdById: user.id,
          })),
        );
      if (generated.length) await tx.areaChecklistItem.createMany({ data: generated });
      await tx.propertyFloorPlan.updateMany({
        where: { propertyId: buildingId, status: FloorPlanStatus.REVIEW_REQUIRED },
        data: { status: FloorPlanStatus.APPROVED },
      });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'PROPERTY_AREAS_APPROVED',
          entityType: 'PropertywareBuilding',
          entityId: buildingId,
          metadata: { areaIds: uniqueIds },
        },
      });
    });
    return this.areas(user, buildingId);
  }

  private validateFile(file: UploadedFloorPlan) {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_MIME_TYPES)[number]))
      throw new ApplicationError(415, 'UNSUPPORTED_FLOOR_PLAN_TYPE', 'Upload a PDF, PNG, or JPEG.');
    if (file.size <= 0 || file.size > 20_000_000)
      throw new ApplicationError(
        413,
        'INVALID_FLOOR_PLAN_SIZE',
        'Floor plans must be 20 MB or smaller.',
      );
    const validSignature =
      (file.mimetype === 'application/pdf' && file.buffer.subarray(0, 5).toString() === '%PDF-') ||
      (file.mimetype === 'image/png' &&
        file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (file.mimetype === 'image/jpeg' &&
        file.buffer[0] === 0xff &&
        file.buffer[1] === 0xd8 &&
        file.buffer[2] === 0xff);
    if (!validSignature)
      throw new ApplicationError(
        422,
        'INVALID_FLOOR_PLAN_FILE',
        'The uploaded file signature is invalid.',
      );
  }

  private async ensureProperty(
    building: Awaited<ReturnType<FloorPlanAdminService['requireBuilding']>>,
  ) {
    return this.prisma.property.upsert({
      where: { id: building.id },
      update: {
        name: building.name,
        addressLine1: building.addressLine1 || 'Address not provided',
        city: building.city || 'Not provided',
        state: building.state || 'TX',
        postalCode: building.postalCode || 'Not provided',
      },
      create: {
        id: building.id,
        organizationId: building.organizationId,
        name: building.name,
        addressLine1: building.addressLine1 || 'Address not provided',
        city: building.city || 'Not provided',
        state: building.state || 'TX',
        postalCode: building.postalCode || 'Not provided',
      },
    });
  }

  private async requireBuilding(organizationId: string, id: string, active = false) {
    const building = await this.prisma.propertywareBuilding.findFirst({
      where: { id, organizationId, ...(active ? { isActive: true } : {}) },
      select: {
        id: true,
        organizationId: true,
        name: true,
        addressLine1: true,
        city: true,
        state: true,
        postalCode: true,
      },
    });
    if (!building) throw new ApplicationError(404, 'PROPERTY_NOT_FOUND', 'Property was not found.');
    return building;
  }

  private async requirePlan(organizationId: string, id: string) {
    const plan = await this.prisma.propertyFloorPlan.findFirst({
      where: { id, property: { organizationId } },
      select: {
        id: true,
        propertyId: true,
        unitId: true,
        storageKey: true,
        fileName: true,
        mimeType: true,
      },
    });
    if (!plan) throw new ApplicationError(404, 'FLOOR_PLAN_NOT_FOUND', 'Floor plan was not found.');
    return plan;
  }

  private async requireUnit(organizationId: string, buildingId: string, unitId: string) {
    const unit = await this.prisma.propertywareUnit.findFirst({
      where: { id: unitId, organizationId, buildingId, isActive: true },
      select: { id: true, name: true },
    });
    if (!unit)
      throw new ApplicationError(
        422,
        'INVALID_ACTIVE_UNIT',
        'Select an active unit belonging to this property.',
      );
    return unit;
  }

  /**
   * The coverage checklist an administrator has authored for one area.
   *
   * Archived items are excluded here but never deleted: an inspection that
   * already recorded coverage against an item must keep resolving it, so
   * removal is a soft archive rather than a delete.
   */
  async areaChecklist(user: AuthenticatedUser, areaId: string) {
    await this.requireArea(user.organizationId, areaId);
    return this.prisma.areaChecklistItem.findMany({
      where: { propertyAreaId: areaId, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, label: true, keywords: true, sortOrder: true },
    });
  }

  async createChecklistItem(
    user: AuthenticatedUser,
    areaId: string,
    input: CreateAreaChecklistItemDto,
  ) {
    const area = await this.requireArea(user.organizationId, areaId);
    const label = input.label.trim();
    const duplicate = await this.prisma.areaChecklistItem.findFirst({
      where: { propertyAreaId: areaId, label, archivedAt: null },
      select: { id: true },
    });
    if (duplicate)
      throw new ApplicationError(
        409,
        'DUPLICATE_CHECKLIST_ITEM',
        'This area already has an item with that wording.',
      );

    // Appended by default, so adding an item never silently reorders the list a
    // technician has been reading.
    const last = await this.prisma.areaChecklistItem.aggregate({
      where: { propertyAreaId: areaId },
      _max: { sortOrder: true },
    });

    // Authored keywords win; otherwise the label supplies its own, so an item
    // added without them still auto-ticks rather than waiting on a manual tap.
    const authored = normalizeKeywords(input.keywords);
    const item = await this.prisma.areaChecklistItem.create({
      data: {
        organizationId: user.organizationId,
        propertyAreaId: area.id,
        label,
        keywords: authored.length ? authored : keywordsFromLabel(label),
        sortOrder: input.sortOrder ?? (last._max.sortOrder ?? -1) + 1,
        createdById: user.id,
      },
      select: { id: true, label: true, keywords: true, sortOrder: true },
    });
    await this.recordChecklistAudit(user, area.id, 'AREA_CHECKLIST_ITEM_ADDED', item.id, { label });
    return item;
  }

  async updateChecklistItem(
    user: AuthenticatedUser,
    itemId: string,
    input: UpdateAreaChecklistItemDto,
  ) {
    const existing = await this.requireChecklistItem(user.organizationId, itemId);
    const label = input.label?.trim() ?? existing.label;
    if (label !== existing.label) {
      const duplicate = await this.prisma.areaChecklistItem.findFirst({
        where: {
          propertyAreaId: existing.propertyAreaId,
          label,
          archivedAt: null,
          NOT: { id: itemId },
        },
        select: { id: true },
      });
      if (duplicate)
        throw new ApplicationError(
          409,
          'DUPLICATE_CHECKLIST_ITEM',
          'This area already has an item with that wording.',
        );
    }

    const item = await this.prisma.areaChecklistItem.update({
      where: { id: itemId },
      data: {
        label,
        ...(input.keywords ? { keywords: normalizeKeywords(input.keywords) } : {}),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      },
      select: { id: true, label: true, keywords: true, sortOrder: true },
    });
    await this.recordChecklistAudit(
      user,
      existing.propertyAreaId,
      'AREA_CHECKLIST_ITEM_UPDATED',
      itemId,
      { label },
    );
    return item;
  }

  /** Soft archive — see `areaChecklist` for why this is not a delete. */
  async archiveChecklistItem(user: AuthenticatedUser, itemId: string) {
    const existing = await this.requireChecklistItem(user.organizationId, itemId);
    await this.prisma.areaChecklistItem.update({
      where: { id: itemId },
      data: { archivedAt: new Date() },
    });
    await this.recordChecklistAudit(
      user,
      existing.propertyAreaId,
      'AREA_CHECKLIST_ITEM_ARCHIVED',
      itemId,
      { label: existing.label },
    );
    return { id: itemId, archived: true };
  }

  private async requireChecklistItem(organizationId: string, id: string) {
    const item = await this.prisma.areaChecklistItem.findFirst({
      // Scoped through the area's property, not the denormalized column alone,
      // so a mismatched organizationId can never widen access.
      where: { id, archivedAt: null, propertyArea: { property: { organizationId } } },
      select: { id: true, label: true, propertyAreaId: true },
    });
    if (!item)
      throw new ApplicationError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'Checklist item was not found.');
    return item;
  }

  private recordChecklistAudit(
    user: AuthenticatedUser,
    areaId: string,
    action: string,
    itemId: string,
    metadata: Record<string, unknown>,
  ) {
    return this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action,
        entityType: 'AreaChecklistItem',
        entityId: itemId,
        metadata: { ...metadata, propertyAreaId: areaId },
      },
    });
  }

  private async requireArea(organizationId: string, id: string) {
    const area = await this.prisma.propertyArea.findFirst({
      where: { id, property: { organizationId } },
      select: propertyAreaResponseSelect,
    });
    if (!area) throw new ApplicationError(404, 'AREA_NOT_FOUND', 'Property area was not found.');
    return area;
  }

  private async findOrCreateFloor(
    propertyId: string,
    unitId: string | null,
    name: string,
    sortOrder: number,
  ) {
    const normalized = name.trim();
    const existing = await this.prisma.propertyFloor.findFirst({
      where: { propertyId, unitId, name: { equals: normalized, mode: 'insensitive' } },
      select: { id: true, propertyId: true, name: true, sortOrder: true },
    });
    return (
      existing ||
      this.prisma.propertyFloor.create({
        data: { propertyId, unitId, name: normalized, sortOrder },
        select: { id: true, propertyId: true, name: true, sortOrder: true },
      })
    );
  }

  private async assertUniqueArea(
    propertyId: string,
    unitId: string | null,
    floorName: string,
    name: string,
    ignoreId?: string,
  ) {
    const duplicate = await this.prisma.propertyArea.findFirst({
      where: {
        propertyId,
        unitId,
        ...(ignoreId ? { id: { not: ignoreId } } : {}),
        name: { equals: name.trim(), mode: 'insensitive' },
        floor: { name: { equals: floorName.trim(), mode: 'insensitive' } },
      },
      select: { id: true },
    });
    if (duplicate)
      throw new ApplicationError(
        409,
        'DUPLICATE_AREA',
        'An area with this name already exists on the selected floor.',
      );
  }

  private audit(
    user: AuthenticatedUser,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Prisma.InputJsonValue,
  ) {
    return this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action,
        entityType,
        entityId,
        metadata,
      },
    });
  }
}
