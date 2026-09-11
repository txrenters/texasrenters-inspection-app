import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InspectionSource, InspectionStatus } from '@prisma/client';
import type { InspectionType, Prisma } from '@prisma/client';

import { InspectionImportService } from '../../admin/inspection-import/inspection-import.service';
import { parseReport } from '../../admin/inspection-import/inspect-cloud-report';
import { readPages } from '../../admin/inspection-import/inspect-cloud-pdf';
import type { ImportedReport } from '../../admin/inspection-import/inspect-cloud-report';
import type { AuthenticatedUser } from '../../common/auth';
import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { PropertywareClient } from './propertyware.client';
import {
  classifyFileName,
  type DocumentKind,
  classifyTemplate,
  isImportableKind,
  looksLikeInspectionReport,
  worthDownloading,
  type PropertywareDocument,
} from './propertyware.inspection-docs';

/**
 * Bringing Propertyware's inspection reports into the console.
 *
 * The office had been exporting these one at a time. There are 4,664 of them —
 * 683 move-ins, 473 move-outs, 1,745 occupied — across 454 of 577 buildings,
 * and they are current rather than archival: 1,442 from 2025 and 1,188 from
 * 2026. Every one is an Inspect & Cloud report in exactly the layout
 * `InspectionImportService` was built and proven against, so nothing here
 * parses anything; it finds the files, decides which inspection each describes,
 * and hands the bytes to the importer.
 *
 * **Two passes, deliberately.** Discovery is one cheap listing request per
 * building and writes only a catalogue row. Importing is a large download each
 * — 19 MB is ordinary, one is 81 MB — so it is a separate, resumable, paceable
 * pass over rows that already exist. Fused into one, a run that stopped
 * half-way would have to re-list and re-download everything to find out where
 * it got to.
 */

/** Paced, not parallel. See {@link PACING_MS}. */
const PACING_MS = 120;

/**
 * How near a report's date has to be to an existing inspection to be *that*
 * inspection.
 *
 * Jobber schedules a visit and the walk happens within a few days; the report
 * is written the same day it is walked but uploaded to Propertyware whenever
 * somebody got to it. So the match is against the inspection's schedule, with a
 * fortnight either side, and the report's own date is what is compared.
 *
 * Wider than it sounds because the alternative is worse in one direction only:
 * too narrow creates a duplicate inspection beside a real one, and a duplicate
 * move-in silently becomes the baseline every future move-out is judged
 * against. Too wide attaches evidence to a scheduled visit that is, at worst,
 * the same walkthrough a fortnight out.
 */
const MATCH_WINDOW_DAYS = 14;

interface DiscoverOptions {
  organizationId: string;
  /** Only list documents Propertyware changed since this; omit for a full sweep. */
  since?: Date;
  /** Stop after this many buildings. For a rehearsal on a handful. */
  limit?: number;
}

interface ImportOptions {
  organizationId: string;
  /** Who the evidence is attributed to; the importer stamps every area with it. */
  actor: AuthenticatedUser;
  /** Restrict to these types. Omit for every importable kind. */
  types?: InspectionType[];
  /** Skip reports dated before this. The office rarely wants 2019 back. */
  since?: Date;
  limit?: number;
  /** Report what would happen and write nothing. */
  dryRun?: boolean;
}

@Injectable()
export class PropertywareInspectionDocsService {
  private readonly logger = new Logger(PropertywareInspectionDocsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PropertywareClient) private readonly client: PropertywareClient,
    @Inject(InspectionImportService) private readonly imports: InspectionImportService,
  ) {}

  /**
   * Walk the buildings and record every inspection report Propertyware holds.
   *
   * Writes catalogue rows and nothing else — no downloads, no inspections. A
   * building with no documents costs one request and produces nothing, which is
   * why this can be re-run freely.
   */
  async discover({ organizationId, since, limit }: DiscoverOptions) {
    const correlationId = randomUUID();
    const buildings = await this.prisma.propertywareBuilding.findMany({
      where: { organizationId },
      select: { id: true, externalId: true, name: true },
      orderBy: { externalId: 'asc' },
      ...(limit ? { take: limit } : {}),
    });

    let listed = 0;
    let discovered = 0;
    let alreadyKnown = 0;
    for (const building of buildings) {
      let documents: PropertywareDocument[] = [];
      try {
        documents = await this.client.listDocuments('BUILDING', building.externalId, correlationId, {
          lastModifiedDateTimeStart: since?.toISOString(),
        });
      } catch (error) {
        // One building's listing failing must not end the sweep: the next 400
        // buildings are unaffected, and a re-run picks this one up.
        this.logger.warn({
          event: 'propertyware_document_listing_failed',
          externalBuildingId: building.externalId,
          message: error instanceof Error ? error.message : 'unknown',
        });
        continue;
      }
      listed += documents.length;

      for (const document of documents.filter(looksLikeInspectionReport)) {
        const guessedKind = classifyFileName(document.fileName);
        const created = await this.prisma.propertywareInspectionDocument.upsert({
          where: { externalDocumentId: String(document.id) },
          // Re-listing a known document refreshes what Propertyware says about
          // it without disturbing what we did with it: status, fingerprint and
          // the inspection it landed in are ours, not theirs.
          update: {
            fileName: document.fileName,
            fileType: document.fileType,
            guessedKind,
          },
          create: {
            organizationId,
            externalDocumentId: String(document.id),
            buildingId: building.id,
            externalBuildingId: building.externalId,
            fileName: document.fileName,
            fileType: document.fileType,
            sourceCreatedAt: document.createdDateTime ? new Date(document.createdDateTime) : null,
            guessedKind,
          },
          select: { createdAt: true, updatedAt: true },
        });
        if (created.createdAt.getTime() === created.updatedAt.getTime()) discovered += 1;
        else alreadyKnown += 1;
      }
      await pause();
    }

    this.logger.log({
      event: 'propertyware_documents_discovered',
      buildings: buildings.length,
      listed,
      discovered,
      alreadyKnown,
    });
    return { buildings: buildings.length, listed, discovered, alreadyKnown };
  }

  /**
   * Download what has been catalogued and write it into an inspection.
   *
   * Sequential on purpose. Each document is a multi-megabyte download followed
   * by a transaction that writes several hundred photographs; running these
   * concurrently trades a slow backfill for an exhausted connection pool and a
   * heap holding a dozen 80 MB buffers at once.
   */
  async importPending({ organizationId, actor, types, since, limit, dryRun }: ImportOptions) {
    const correlationId = randomUUID();
    const pending = await this.prisma.propertywareInspectionDocument.findMany({
      where: {
        organizationId,
        status: 'DISCOVERED',
        ...(types?.length ? { guessedKind: { in: types } } : {}),
        ...(since ? { sourceCreatedAt: { gte: since } } : {}),
      },
      select: {
        id: true,
        externalDocumentId: true,
        fileName: true,
        guessedKind: true,
        buildingId: true,
        building: { select: { id: true, name: true, addressLine1: true } },
      },
      orderBy: { sourceCreatedAt: 'desc' },
      ...(limit ? { take: limit } : {}),
    });

    const outcome = { considered: pending.length, imported: 0, skipped: 0, failed: 0 };
    for (const row of pending) {
      try {
        /**
         * The filename only decides whether to fetch the bytes.
         *
         * `UNKNOWN` is fetched, not discarded: the name is a guess and the
         * report's own template line is the answer, so a name nobody
         * anticipated should cost one download and then be decided properly.
         * That is not hypothetical — "Turnover Inspection", "TO Inspection",
         * "Exit Inspection" and `occupiedinspection` written without a space
         * were all sitting unclassified after the first discovery run.
         *
         * Only two are certainly not one inspection and are never fetched: an
         * owner's move-in-versus-move-out summary, and somebody else's HOA or
         * municipal visit.
         */
        if (!worthDownloading(row.guessedKind as DocumentKind)) {
          await this.settle(row.id, 'SKIPPED', { errorCode: 'NOT_AN_INSPECTION_TYPE' });
          outcome.skipped += 1;
          continue;
        }

        const { bytes } = await this.client.downloadDocument(
          row.externalDocumentId,
          correlationId,
        );

        /**
         * Read before deciding which inspection this is.
         *
         * The filename got it this far — it is what made the download worth
         * doing — but the report's own template line is what it actually is,
         * and the two disagree often enough to matter. A move-out's evidence
         * written into a move-in is not a cosmetic error: the move-in is the
         * baseline every later move-out is compared against.
         */
        const report = parseReport(await readPages(bytes));
        const kind = classifyTemplate(report.template);
        if (!isImportableKind(kind)) {
          await this.settle(row.id, 'SKIPPED', {
            errorCode: 'TEMPLATE_NOT_RECOGNISED',
            sizeBytes: bytes.length,
          });
          outcome.skipped += 1;
          continue;
        }

        if (dryRun) {
          this.logger.log({
            event: 'propertyware_document_would_import',
            fileName: row.fileName,
            guessed: row.guessedKind,
            template: report.template,
            kind,
            areas: report.areas.length,
            reportDate: report.reportDate,
          });
          outcome.skipped += 1;
          continue;
        }

        const inspectionId = await this.resolveInspection({
          organizationId,
          buildingId: row.buildingId,
          type: kind,
          report,
          actorId: actor.id,
        });

        const result = await this.imports.importPreparsed(
          actor,
          inspectionId,
          {
            originalname: row.fileName,
            mimetype: 'application/pdf',
            size: bytes.length,
            buffer: bytes,
          },
          report,
        );

        await this.settle(row.id, result.committed ? 'IMPORTED' : 'FAILED', {
          inspectionType: kind,
          inspectionId: result.inspectionId,
          fingerprint: result.fingerprint,
          sizeBytes: bytes.length,
          errorCode: result.errorCode,
          importedAt: result.committed ? new Date() : null,
        });
        if (result.committed) outcome.imported += 1;
        else outcome.failed += 1;
      } catch (error) {
        // `REPORT_ALREADY_IMPORTED` is the ordinary case, not a fault: the
        // office re-uploads the same report, so two catalogue rows can carry
        // one file. Recorded as skipped so a re-run does not keep retrying it.
        const code = error instanceof ApplicationError ? error.code : 'IMPORT_FAILED';
        const skipped = code === 'REPORT_ALREADY_IMPORTED';
        await this.settle(row.id, skipped ? 'SKIPPED' : 'FAILED', { errorCode: code });
        if (skipped) outcome.skipped += 1;
        else outcome.failed += 1;
        this.logger.warn({
          event: 'propertyware_document_import_failed',
          externalDocumentId: row.externalDocumentId,
          fileName: row.fileName,
          code,
        });
      }
      await pause();
    }

    this.logger.log({ event: 'propertyware_documents_imported', ...outcome });
    return outcome;
  }

  /**
   * The inspection this report belongs to, created if there is not one.
   *
   * Most of these have no record here at all. Jobber only became the scheduling
   * source of record in 2026 and only ever knew about visits it scheduled, so a
   * move-in walked in 2021 exists solely as a PDF in Propertyware. Refusing to
   * create one would discard four fifths of the backfill.
   *
   * Matching first, though, because the opposite mistake is worse. A Jobber
   * visit that completed leaves a *finished, empty* inspection here — that is
   * the exact case the importer was built for — and creating a second one
   * beside it would leave two records for one walkthrough. The comparison takes
   * the latest move-in, so the duplicate would quietly become the baseline.
   */
  private async resolveInspection(input: {
    organizationId: string;
    buildingId: string;
    type: InspectionType;
    report: ImportedReport;
    actorId: string;
  }) {
    const walkedAt = reportDate(input.report.reportDate);
    const window = MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const existing = await this.prisma.inspection.findFirst({
      where: {
        organizationId: input.organizationId,
        propertywareBuildingId: input.buildingId,
        inspectionType: input.type,
        ...(walkedAt
          ? {
              scheduledAt: {
                gte: new Date(walkedAt.getTime() - window),
                lte: new Date(walkedAt.getTime() + window),
              },
            }
          : {}),
      },
      orderBy: { scheduledAt: 'desc' },
      select: { id: true },
    });
    if (existing) return existing.id;

    /**
     * Created as COMPLETED and deliberately **not** finalized.
     *
     * The walk happened — years ago, for most of these — so a SCHEDULED record
     * would be a lie and would show up in the technicians' work lists as
     * something to go and do. But `finalizedAt` freezes evidence permanently
     * and stands for a person having signed the report off, and nobody here
     * has. It stays open for review, which is what every other import does.
     */
    const created = await this.prisma.inspection.create({
      data: {
        organizationId: input.organizationId,
        propertywareBuildingId: input.buildingId,
        inspectionType: input.type,
        status: InspectionStatus.COMPLETED,
        source: InspectionSource.IMPORTED_REPORT,
        scheduledAt: walkedAt ?? new Date(),
        completedAt: walkedAt ?? new Date(),
        createdById: input.actorId,
        internalNotes: `Created from a Propertyware document (${input.report.template ?? 'unknown template'}).`,
      },
      select: { id: true },
    });
    return created.id;
  }

  private settle(
    id: string,
    status: 'IMPORTED' | 'SKIPPED' | 'FAILED' | 'DOWNLOADED',
    data: Prisma.PropertywareInspectionDocumentUpdateInput = {},
  ) {
    return this.prisma.propertywareInspectionDocument.update({
      where: { id },
      data: { status, ...data },
    });
  }
}

/**
 * The report's own date, which is the one that counts.
 *
 * Inspect & Cloud writes it as `DEC-21-2023` in the page header. Not the
 * document's Propertyware timestamp: reports are uploaded whenever somebody got
 * to it, and one at 7306 Cypress Prairie was filed eight months after the walk.
 */
function reportDate(value: string | null | undefined): Date | null {
  const match = /^([A-Z]{3})-(\d{1,2})-(\d{4})$/i.exec((value ?? '').trim());
  if (!match) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months.indexOf(match[1].toLowerCase());
  if (month < 0) return null;
  const parsed = new Date(Date.UTC(Number(match[3]), month, Number(match[2])));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A courtesy to Propertyware, which rate-limits and which nobody else is using. */
const pause = () => new Promise((resolve) => setTimeout(resolve, PACING_MS));
