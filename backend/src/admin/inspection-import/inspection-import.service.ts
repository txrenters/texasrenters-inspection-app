/**
 * Importing an inspection that happened outside this app.
 *
 * Some properties are walked by an agent using Inspect & Cloud, or were walked
 * before the handset existed. The result is a PDF, and without it a later
 * move-out has nothing to compare against: `ComparisonService.resolveBaseline`
 * looks for a *move-in* on the same property and refuses with
 * `MOVE_IN_BASELINE_NOT_FOUND` when there is none.
 *
 * What this writes is the inspection, its areas, the condition of every item
 * the report graded, and every photograph. What it does **not** write is
 * `InspectionFinding` rows: that table requires `inspectionMediaId` and is
 * built around AI analysis of a video, which an imported report does not have.
 * The defects are not lost — each one is the comment and the failed grades on
 * its checklist response, which is where the web review screen already reads
 * condition from. The consequence to know about is that
 * `ComparisonService.loadDamageCounts` counts findings, so pre-existing damage
 * from an import does not yet reach a comparison's damage tally; making that
 * work needs `inspectionMediaId` to become nullable, which is a change to a
 * core evidence table and is deliberately not bundled here.
 */
import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  Prisma} from '@prisma/client';
import {
  type AreaCategory,
  type AreaEnvironment,
  InspectionSource,
  InspectionStatus,
  InspectionType
} from '@prisma/client';
import { classifyAreaByName, keywordsFromLabel } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../../common/auth';
import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { InspectionMediaStorageService } from '../../technician/inspection-media-storage.service';
import { CONFIDENT_MATCH, parseReport, reportFingerprint } from './inspect-cloud-report';
import type { ImportedArea, ImportedReport } from './inspect-cloud-report';
import { countPhotosPerPage, extractPhotos, readPages } from './inspect-cloud-pdf';
import type { ExtractedPhoto } from './inspect-cloud-pdf';

/** The shape multer hands over, kept local so the controller need not import it. */
export interface UploadedReport {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** What a report has to contain before it is worth importing at all. */
const MINIMUM_AREAS = 1;

export interface ImportPreview {
  fingerprint: string;
  inspector: string | null;
  template: string | null;
  reportDate: string | null;
  alreadyImported: { inspectionId: string; importedAt: Date } | null;
  areas: Array<{
    name: string;
    matchesExistingArea: boolean;
    items: number;
    assessed: number;
    photos: number;
    defects: Array<{ item: string; comment: string | null; failed: string[] }>;
  }>;
  totals: { areas: number; items: number; photos: number; defects: number };
  /** Everything a person should look at before committing. */
  needsReview: {
    lowConfidenceLabels: Array<{ area: string; sourceLabel: string; matched: string | null; score: number }>;
    unrecognisedRows: ImportedReport['unrecognised'];
    photosWithoutSubject: number;
  };
}

@Injectable()
export class InspectionImportService {
  private readonly logger = new Logger(InspectionImportService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InspectionMediaStorageService) private readonly storage: InspectionMediaStorageService,
  ) {}

  /**
   * Read the file and say what importing it would do. Writes nothing.
   *
   * Separate from the commit because the parser cannot be certain about
   * everything: a label the templates do not carry, a row the inspector typed
   * by hand, a photograph whose caption did not resolve. An administrator
   * seeing those before anything is written is the difference between an
   * import and a guess.
   */
  async preview(user: AuthenticatedUser, propertyId: string, file?: { buffer: Buffer }) {
    const { bytes, report } = await this.read(file);
    const property = await this.requireProperty(user, propertyId);
    const fingerprint = reportFingerprint(bytes);
    const existing = await this.findPreviousImport(user.organizationId, fingerprint);
    const photos = extractPhotos(bytes);

    const existingAreas = await this.prisma.propertyArea.findMany({
      where: { propertyId: property.id, archivedAt: null },
      select: { name: true },
    });
    const known = new Set(existingAreas.map((area) => normalise(area.name)));

    return {
      fingerprint,
      inspector: report.inspector,
      template: report.template,
      reportDate: report.reportDate,
      alreadyImported: existing,
      areas: report.areas.map((area) => ({
        name: area.name,
        matchesExistingArea: known.has(normalise(area.name)),
        items: area.items.length,
        assessed: area.items.filter((item) => item.assessed).length,
        photos: area.photos.length,
        defects: defectsIn(area).map((item) => ({
          item: item.matchedLabel ?? item.sourceLabel,
          comment: item.comment,
          failed: failedAxes(item),
        })),
      })),
      totals: {
        areas: report.areas.length,
        items: report.areas.reduce((count, area) => count + area.items.length, 0),
        // The count from the file itself, not from the captions: a mismatch
        // between the two is the signal that attribution has gone wrong.
        photos: photos.length,
        defects: report.areas.reduce((count, area) => count + defectsIn(area).length, 0),
      },
      needsReview: {
        lowConfidenceLabels: report.areas.flatMap((area) =>
          area.items
            .filter((item) => item.matchScore < CONFIDENT_MATCH)
            .map((item) => ({
              area: area.name,
              sourceLabel: item.sourceLabel,
              matched: item.matchedLabel,
              score: item.matchScore,
            })),
        ),
        unrecognisedRows: report.unrecognised,
        photosWithoutSubject: report.areas.reduce(
          (count, area) => count + area.photos.filter((photo) => !photo.matchedLabel).length,
          0,
        ),
      },
    } satisfies ImportPreview;
  }

  /**
   * Write the report in as a move-in inspection.
   *
   * Left un-finalized on purpose. `finalizedAt` freezes evidence permanently,
   * and an import arrives with matches a person has not confirmed yet — so it
   * lands in review, where an administrator finalizes it the same way they
   * would an inspection the app captured.
   */
  async commit(user: AuthenticatedUser, propertyId: string, file?: { buffer: Buffer }) {
    const { bytes, report } = await this.read(file);
    const property = await this.requireProperty(user, propertyId);
    const fingerprint = reportFingerprint(bytes);

    // The same file twice is almost always somebody clicking again, and a
    // second baseline for one walkthrough is worse than a refusal: the
    // comparison picks the latest move-in, so a duplicate silently becomes the
    // one every future move-out is judged against.
    const previous = await this.findPreviousImport(user.organizationId, fingerprint);
    if (previous)
      throw new ApplicationError(
        409,
        'REPORT_ALREADY_IMPORTED',
        'This report has already been imported.',
        [previous],
      );

    const photos = extractPhotos(bytes);
    const perPage = await countPhotosPerPage(bytes);
    const stored = await this.storePhotos(user.organizationId, fingerprint, photos);

    const inspectionId = await this.prisma.$transaction(async (tx) => {
      await tx.property.upsert({
        where: { id: property.id },
        update: {},
        create: {
          id: property.id,
          organizationId: user.organizationId,
          name: property.name,
          // The same fallbacks the floor-plan admin uses: these columns are
          // required and a Propertyware building is not guaranteed to have them.
          addressLine1: property.addressLine1 || 'Address not provided',
          city: property.city || 'Not provided',
          state: property.state || 'TX',
          postalCode: property.postalCode || 'Not provided',
        },
      });

      const inspection = await tx.inspection.create({
        data: {
          organizationId: user.organizationId,
          propertyId: property.id,
          // Both, and both the building's id. `propertywareBuildingId` is what
          // `ComparisonService.resolveBaseline` scopes on, so an import that
          // left it null would be invisible to the move-out it exists to serve.
          propertywareBuildingId: property.id,
          inspectionType: InspectionType.MOVE_IN,
          source: InspectionSource.IMPORTED_REPORT,
          status: InspectionStatus.UNDER_REVIEW,
          scheduledAt: reportDay(report.reportDate),
          completedAt: new Date(),
          createdById: user.id,
          internalNotes: importNote(report, fingerprint),
        },
        select: { id: true },
      });

      let photoCursor = 0;
      for (const area of report.areas) {
        const propertyArea = await this.resolveArea(tx, property.id, area.name, user.id);
        const inspectionArea = await tx.inspectionArea.create({
          data: {
            inspectionId: inspection.id,
            propertyAreaId: propertyArea.id,
            completionStatus: 'COMPLETED',
            completedAt: new Date(),
          },
          select: { id: true },
        });

        const items = new Map<string, string>();
        for (const item of area.items) {
          const label = item.matchedLabel ?? item.sourceLabel;
          const checklistItem = await this.resolveChecklistItem(
            tx,
            user.organizationId,
            propertyArea.id,
            label,
            user.id,
          );
          items.set(label, checklistItem.id);
          await tx.inspectionAreaChecklistResponse.create({
            data: {
              organizationId: user.organizationId,
              inspectionAreaId: inspectionArea.id,
              checklistItemId: checklistItem.id,
              // Null where the report left the row blank. Storing false there
              // would turn "the inspector did not look" into "it failed", and
              // a move-out would be compared against a defect nobody recorded.
              isClean: item.isClean,
              isUndamaged: item.isUndamaged,
              isWorking: item.isWorking,
              comment: item.comment,
              recordedById: user.id,
            },
          });
        }

        for (const photo of area.photos) {
          const bytesForPhoto = stored[photoCursor];
          photoCursor += 1;
          if (!bytesForPhoto) continue;
          const label = photo.matchedLabel ?? photo.caption;
          await tx.inspectionPhoto.create({
            data: {
              organizationId: user.organizationId,
              inspectionId: inspection.id,
              inspectionAreaId: inspectionArea.id,
              checklistItemId: label ? (items.get(label) ?? null) : null,
              capturedById: user.id,
              provider: this.storage.providerName(),
              storageKey: bytesForPhoto.storageKey,
              mimeType: 'image/jpeg',
              width: bytesForPhoto.width,
              height: bytesForPhoto.height,
              sizeBytes: bytesForPhoto.sizeBytes,
              label: photo.caption,
              capturedAt: captureTime(photo.takenAt) ?? new Date(),
              idempotencyKey: bytesForPhoto.storageKey,
              metadata: { importedFrom: fingerprint, page: photo.page },
            },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'INSPECTION_REPORT_IMPORTED',
          entityType: 'Inspection',
          entityId: inspection.id,
          metadata: {
            fingerprint,
            areas: report.areas.length,
            photos: stored.length,
            pagesWithPhotos: perPage.filter((count) => count > 0).length,
            unrecognisedRows: report.unrecognised.length,
          },
        },
      });

      return inspection.id;
    });

    this.logger.log({ event: 'inspection_report_imported', inspectionId });
    return { inspectionId, areas: report.areas.length, photos: stored.length };
  }

  private async read(file?: { buffer: Buffer }) {
    if (!file?.buffer?.length)
      throw new ApplicationError(400, 'REPORT_FILE_REQUIRED', 'Attach the report PDF to import.');
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-')
      throw new ApplicationError(400, 'REPORT_NOT_A_PDF', 'That file is not a PDF.');

    let report: ImportedReport;
    try {
      report = parseReport(await readPages(file.buffer));
    } catch {
      // Never the parser's own words: they describe a table this file does not
      // have, which reads as a bug in the report rather than a wrong file.
      throw new ApplicationError(
        422,
        'REPORT_NOT_READABLE',
        'This PDF could not be read as an inspection report.',
      );
    }
    // A different vendor's export parses without throwing and yields nothing.
    // Refusing here is the difference between "we cannot read this" and an
    // empty inspection that looks like a completed walkthrough.
    if (report.areas.length < MINIMUM_AREAS)
      throw new ApplicationError(
        422,
        'REPORT_NOT_RECOGNISED',
        'No inspection areas were found. This does not look like an Inspect & Cloud report.',
      );
    return { bytes: file.buffer, report };
  }

  /**
   * The Propertyware building this report describes.
   *
   * The id in the path is a *building* id, the same one every other inspection
   * route takes. `PropertyArea.propertyId` also carries a building id, but its
   * foreign key references `Property` — a separate, lazily populated table
   * where most buildings have no row. So the row is upserted before any area
   * points at it, exactly as the floor-plan admin and the HVAC path already do;
   * creating the area first violates `PropertyArea_propertyId_fkey`.
   */
  private async requireProperty(user: AuthenticatedUser, buildingId: string) {
    const building = await this.prisma.propertywareBuilding.findFirst({
      where: { id: buildingId, organizationId: user.organizationId },
      select: {
        id: true,
        name: true,
        addressLine1: true,
        city: true,
        state: true,
        postalCode: true,
      },
    });
    if (!building)
      throw new ApplicationError(404, 'PROPERTY_NOT_FOUND', 'Property was not found.');
    return building;
  }

  private findPreviousImport(organizationId: string, fingerprint: string) {
    return this.prisma.auditLog.findFirst({
      where: {
        organizationId,
        action: 'INSPECTION_REPORT_IMPORTED',
        metadata: { path: ['fingerprint'], equals: fingerprint },
      },
      select: { entityId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }).then((row) => (row ? { inspectionId: row.entityId, importedAt: row.createdAt } : null));
  }

  /**
   * The property's area of this name, created if the property does not have it.
   *
   * Matched on a normalised name rather than exactly, because the report writes
   * "BEDROOM 1" where the console holds "Bedroom 1". Anything it does not
   * recognise is added rather than dropped: the report is evidence that the
   * room was walked, and an inspection missing a room it covered would read as
   * incomplete work.
   */
  private async resolveArea(
    tx: Prisma.TransactionClient,
    propertyId: string,
    name: string,
    createdById: string,
  ) {
    const areas = await tx.propertyArea.findMany({
      where: { propertyId, archivedAt: null },
      select: { id: true, name: true },
    });
    const match = areas.find((area) => normalise(area.name) === normalise(name));
    if (match) return match;

    const classification = classifyAreaByName(name);
    const order = areas.length + 1;
    return tx.propertyArea.create({
      data: {
        propertyId,
        name: titleCase(name),
        inspectionOrder: order,
        // Approved on arrival: this room was walked and photographed, so
        // leaving it a draft would hide it from the very inspection it belongs
        // to. The provenance is on the source column and in the audit row.
        status: 'APPROVED',
        source: 'IMPORTED_REPORT',
        environment: classification.environment as AreaEnvironment,
        category: (classification.category ?? null) as AreaCategory | null,
        createdById,
      },
      select: { id: true, name: true },
    });
  }

  /** The area's checklist item of this label, created if it has none. */
  private async resolveChecklistItem(
    tx: Prisma.TransactionClient,
    organizationId: string,
    propertyAreaId: string,
    label: string,
    createdById: string,
  ) {
    const existing = await tx.areaChecklistItem.findFirst({
      where: { propertyAreaId, label, archivedAt: null },
      select: { id: true },
    });
    if (existing) return existing;
    const count = await tx.areaChecklistItem.count({ where: { propertyAreaId } });
    return tx.areaChecklistItem.create({
      data: {
        organizationId,
        propertyAreaId,
        label,
        keywords: keywordsFromLabel(label),
        sortOrder: count,
        createdById,
      },
      select: { id: true },
    });
  }

  /**
   * The photographs, in the file, written to object storage.
   *
   * Done before the transaction opens. Uploading several hundred objects
   * inside one would hold it open for minutes and lose the whole import to the
   * pooler's statement timeout; a stored object with no row is recoverable,
   * a half-written inspection is not.
   */
  private async storePhotos(
    organizationId: string,
    fingerprint: string,
    photos: readonly ExtractedPhoto[],
  ) {
    const stored: Array<{ storageKey: string; width: number; height: number; sizeBytes: number }> = [];
    for (const [index, photo] of photos.entries()) {
      // Keyed by the content, so re-running a failed import overwrites its own
      // objects rather than leaving a second copy of every photograph.
      const digest = createHash('sha256').update(photo.bytes).digest('hex').slice(0, 32);
      const storageKey = `${organizationId}/imported/${fingerprint.slice(0, 16)}/${String(index).padStart(4, '0')}-${digest}.jpg`;
      await this.storage.putBytes(storageKey, photo.bytes, 'image/jpeg');
      stored.push({
        storageKey,
        width: photo.width,
        height: photo.height,
        sizeBytes: photo.bytes.length,
      });
    }
    return stored;
  }
}

/** What the inspection says about where it came from, in plain words. */
function importNote(report: ImportedReport, fingerprint: string) {
  const parts = [
    'Imported from an Inspect & Cloud PDF report.',
    report.inspector ? `Inspector: ${report.inspector}.` : null,
    report.template ? `Template: ${report.template}.` : null,
    report.reportDate ? `Report date: ${report.reportDate}.` : null,
    `Source fingerprint: ${fingerprint.slice(0, 16)}.`,
  ];
  return parts.filter((part): part is string => part !== null).join(' ');
}

const normalise = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const titleCase = (value: string) =>
  value
    .toLowerCase()
    .replace(/\b[a-z]/g, (character) => character.toUpperCase())
    .trim();

const failedAxes = (item: {
  isClean: boolean | null;
  isUndamaged: boolean | null;
  isWorking: boolean | null;
}) =>
  [
    item.isClean === false ? 'not clean' : null,
    item.isUndamaged === false ? 'damaged' : null,
    item.isWorking === false ? 'not working' : null,
  ].filter((axis): axis is string => axis !== null);

const defectsIn = (area: ImportedArea) =>
  area.items.filter((item) => item.comment !== null || failedAxes(item).length > 0);

/**
 * The day the report covers.
 *
 * `scheduledAt` is a `date` column and the comparison orders baselines by it,
 * so a wrong day here silently changes which move-in a move-out is judged
 * against. Parsed from the report's own header; today only when it has none.
 */
function reportDay(reportDate: string | null) {
  if (!reportDate) return new Date();
  const [month, day, year] = reportDate.split('-');
  const parsed = new Date(`${day}-${month}-${year}`);
  return Number.isNaN(parsed.valueOf()) ? new Date() : parsed;
}

/** "Sep 02 2026 01:15:39 PM" as it was written, or null if it will not parse. */
function captureTime(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}
