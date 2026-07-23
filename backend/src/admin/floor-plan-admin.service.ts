import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { FloorPlanStatus, PropertyAreaStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import type { CreatePropertyAreaDto, UpdatePropertyAreaDto } from './admin.dto';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { FloorPlanExtractionService } from './floor-plan-extraction.service';
import { FloorPlanStorageService } from './floor-plan-storage.service';

export interface UploadedFloorPlan {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

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
  status: true,
  source: true,
  floor: { select: { id: true, name: true, sortOrder: true } },
  _count: { select: { inspectionAreas: true } },
} satisfies Prisma.PropertyAreaSelect;

@Injectable()
export class FloorPlanAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FloorPlanStorageService) private readonly storage: FloorPlanStorageService,
    @Inject(FloorPlanExtractionService) private readonly extraction: FloorPlanExtractionService,
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

  async extract(user: AuthenticatedUser, floorPlanId: string) {
    const plan = await this.requirePlan(user.organizationId, floorPlanId);
    const configuration = await this.aiSettings.resolve(user.organizationId);
    const descriptor = this.extraction.descriptor(configuration);
    const job = await this.prisma.floorPlanExtractionJob.create({
      data: { floorPlanId, status: 'RUNNING', ...descriptor },
    });
    await this.prisma.propertyFloorPlan.update({
      where: { id: floorPlanId },
      data: { status: FloorPlanStatus.PROCESSING },
    });
    try {
      const extractionResult = await this.extraction.extract(
        await this.storage.get(plan.storageKey),
        plan.mimeType,
        configuration,
      );
      const extracted = extractionResult.areas;
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
          const areaKey = (floorName: string, name: string) =>
            `${floorName.trim().toLowerCase()}|${name.trim().toLowerCase()}`;
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
          const areaRows = fresh.map((suggestion) => ({
            id: randomUUID(),
            propertyId: plan.propertyId,
            unitId: plan.unitId,
            floorId: floorIdByName.get(suggestion.floorName.trim().toLowerCase())!,
            name: suggestion.name,
            inspectionOrder: suggestion.inspectionOrder,
            isRequired: suggestion.isRequired,
            source: 'AI_FLOOR_PLAN',
            status: PropertyAreaStatus.DRAFT,
          }));
          if (areaRows.length) await tx.propertyArea.createMany({ data: areaRows });
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
          return { ...job, status: 'COMPLETED', output, summary, areas: created };
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
      throw error;
    }
  }

  async areas(user: AuthenticatedUser, buildingId: string) {
    await this.requireBuilding(user.organizationId, buildingId);
    return this.prisma.propertyArea.findMany({
      where: { propertyId: buildingId },
      select: propertyAreaResponseSelect,
      orderBy: [{ inspectionOrder: 'asc' }, { name: 'asc' }],
    });
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
        source: 'MANUAL',
        status: PropertyAreaStatus.DRAFT,
      },
      select: propertyAreaResponseSelect,
    });
    await this.audit(user, 'PROPERTY_AREA_CREATED', 'PropertyArea', area.id, {
      propertywareBuildingId: buildingId,
      unitId,
    });
    return area;
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
      if (approved) return approved;

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
      return area;
    });
  }

  async updateArea(user: AuthenticatedUser, areaId: string, input: UpdatePropertyAreaDto) {
    const area = await this.requireArea(user.organizationId, areaId);
    if (area.status !== PropertyAreaStatus.DRAFT)
      throw new ApplicationError(409, 'AREA_ALREADY_APPROVED', 'Approved areas cannot be edited.');
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
    return this.prisma.propertyArea.update({
      where: { id: areaId },
      data: {
        ...(input.name ? { name } : {}),
        ...(input.floorName ? { floorId: floor?.id } : {}),
        ...(input.inspectionOrder ? { inspectionOrder: input.inspectionOrder } : {}),
        ...(input.isRequired === undefined ? {} : { isRequired: input.isRequired }),
      },
      select: propertyAreaResponseSelect,
    });
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
    return { deleted: true };
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
      select: { id: true },
    });
    if (selected.length !== uniqueIds.length)
      throw new ApplicationError(
        422,
        'INVALID_AREA_SELECTION',
        'Select only draft areas for this property.',
      );
    await this.prisma.$transaction(async (tx) => {
      await tx.propertyArea.updateMany({
        where: { id: { in: uniqueIds } },
        data: { status: PropertyAreaStatus.APPROVED },
      });
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
