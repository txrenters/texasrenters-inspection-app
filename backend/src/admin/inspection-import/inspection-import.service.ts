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
  InspectionType
} from '@prisma/client';
import { classifyAreaByName, keywordsFromLabel } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../../common/auth';
import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { InspectionMediaStorageService } from '../../technician/inspection-media-storage.service';
import { InspectCloudAiService } from './inspect-cloud-ai.service';
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

/**
 * A reading that has not moved in this long lost its process.
 *
 * The work is fire-and-forget in the API process, so a restart mid-read leaves
 * a row that says RUNNING and never will again. Reported as failed rather than
 * left spinning, which is the difference between "try again" and a page that
 * never resolves.
 */
const IMPORT_STALE_AFTER_MS = 10 * 60 * 1000;
/**
 * How many photographs are uploaded at once.
 *
 * A report carries a few hundred — 271 in one recent import, 376 in another —
 * and each one is a separate round trip to object storage. Sending them one at
 * a time spent almost the whole import waiting on the network, which is what
 * made an import feel like something that had to be watched rather than
 * started.
 *
 * Eight rather than "all of them": several hundred simultaneous uploads would
 * trade a slow import for an exhausted socket pool and R2 rate limits, and the
 * curve is flat well before that. It is a division of the wait, not a race.
 */
const PHOTO_UPLOAD_CONCURRENCY = 8;
/**
 * What a person should look at before any of this is written.
 *
 * The parser refuses to guess, so what it could not resolve is surfaced rather
 * than smoothed over: a label no template carries, a row the inspector typed by
 * hand, a photograph whose caption did not match anything. These are the whole
 * reason the import is two steps instead of one.
 */
export function summarise(report: ImportedReport) {
  return {
    inspector: report.inspector,
    template: report.template,
    reportDate: report.reportDate,
    areas: report.areas.map((area) => ({
      name: area.name,
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
      photos: report.areas.reduce((count, area) => count + area.photos.length, 0),
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
  };
}

/** Where the uploaded report itself is kept, keyed by its own content. */
const sourceKey = (organizationId: string, fingerprint: string) =>
  `${organizationId}/imported/${fingerprint.slice(0, 16)}/source.pdf`;

const isStale = (updatedAt: Date) => Date.now() - updatedAt.getTime() > IMPORT_STALE_AFTER_MS;

/** Why a model could not read a report, in terms the console can show. */
const aiFailureCode = (reason: 'NO_CREDENTIAL' | 'REFUSED' | 'INVALID_OUTPUT' | 'OK') =>
  reason === 'NO_CREDENTIAL' ? 'REPORT_NOT_RECOGNISED_NO_AI' : 'REPORT_NOT_READABLE';

@Injectable()
export class InspectionImportService {
  private readonly logger = new Logger(InspectionImportService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InspectionMediaStorageService) private readonly storage: InspectionMediaStorageService,
    @Inject(InspectCloudAiService) private readonly ai: InspectCloudAiService,
  ) {}

  /**
   * Begin reading a report for an inspection that already exists.
   *
   * Jobber is the scheduling source of record, so a move-in walked in Inspect &
   * Cloud arrives here as a *completed* inspection with nothing in it — no
   * areas, no photographs, no findings. The walkthrough happened; the evidence
   * went to another system. This is what puts the evidence back, so the record
   * a later move-out is compared against is the one Jobber already created.
   *
   * A 48-page report with 376 photographs takes longer than a browser will
   * wait, and killing the work when the connection drops is how floor-plan
   * extraction used to fail: the handler ran to completion and logged success
   * while the caller saw an empty response. The job row is the answer instead —
   * the console polls it, and closing the tab costs nothing.
   */
  async start(user: AuthenticatedUser, inspectionId: string, file?: UploadedReport) {
    if (!file?.buffer?.length)
      throw new ApplicationError(400, 'REPORT_FILE_REQUIRED', 'Attach the report PDF to import.');
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-')
      throw new ApplicationError(400, 'REPORT_NOT_A_PDF', 'That file is not a PDF.');

    const inspection = await this.requireSeedableInspection(user, inspectionId);
    const fingerprint = reportFingerprint(file.buffer);

    const previous = await this.findPreviousImport(user.organizationId, fingerprint);
    if (previous)
      throw new ApplicationError(
        409,
        'REPORT_ALREADY_IMPORTED',
        'This report has already been imported.',
        [previous],
      );

    // One reading of a file at a time. Two would race over the same import and
    // could both commit, and a second baseline for one walkthrough silently
    // becomes the one every future move-out is judged against.
    const running = await this.prisma.inspectionImportJob.findFirst({
      where: { organizationId: user.organizationId, fingerprint, status: 'RUNNING' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, updatedAt: true },
    });
    if (running && !isStale(running.updatedAt))
      return { jobId: running.id, status: 'RUNNING' as const };

    const job = await this.prisma.inspectionImportJob.create({
      data: {
        organizationId: user.organizationId,
        buildingId: inspection.propertywareBuildingId ?? inspection.id,
        inspectionId: inspection.id,
        fingerprint,
        status: 'RUNNING',
        startedById: user.id,
      },
      select: { id: true },
    });

    // Kept, not just read. The commit needs the photographs out of it, and an
    // imported inspection is argued from somebody else's record -- so the
    // record itself is retained rather than discarded once parsed.
    await this.storage.putBytes(sourceKey(user.organizationId, fingerprint), file.buffer, 'application/pdf');

    // Deliberately not awaited, exactly as floor-plan extraction does it:
    // `runExtraction` records its own outcome. The trailing catch is what makes
    // "never rejects" true rather than intended -- an unhandled rejection from
    // a floating promise takes the process down, and the one place that can
    // still throw is the error handling itself.
    void this.runExtraction(user, job.id, file.buffer).catch((error: unknown) => {
      this.logger.error({
        event: 'inspection_import_crashed',
        message: error instanceof Error ? error.message : 'unknown',
      });
    });
    return { jobId: job.id, status: 'RUNNING' as const };
  }

  /**
   * The import currently attached to an inspection, if there is one.
   *
   * Both phases of an import are detached — the reading and the writing each
   * return a job id and record their own outcome — so an import has never
   * needed anybody to sit and watch it. The console could not say so, because
   * the only way to ask after a job was to already hold its id, and that id
   * lived in a dialog. Closing the dialog therefore *looked* like abandoning
   * the import, and the office ran them one at a time.
   *
   * This is what lets any page ask "is something running here?" without having
   * been the one that started it. Newest first, and only the last one: an
   * inspection is seeded once, so an older job is history rather than state.
   */
  async activeJob(user: AuthenticatedUser, inspectionId: string) {
    const job = await this.prisma.inspectionImportJob.findFirst({
      where: { organizationId: user.organizationId, inspectionId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    // Deliberately null rather than a 404: "nothing is importing" is the
    // ordinary answer for almost every inspection, and an error would make the
    // console treat the common case as a failure.
    if (!job) return null;
    // Through `job` so the staleness rule and the summary are computed in one
    // place. A second copy of either would drift the first time one changed.
    return this.job(user, job.id);
  }

  /** What the console polls while the page is open, or after coming back to it. */
  async job(user: AuthenticatedUser, jobId: string) {
    const job = await this.prisma.inspectionImportJob.findFirst({
      where: { id: jobId, organizationId: user.organizationId },
    });
    if (!job) throw new ApplicationError(404, 'IMPORT_JOB_NOT_FOUND', 'Import job was not found.');
    // A job whose process died mid-read is reported as failed rather than left
    // running forever, which is what a spinner with no end looks like.
    if (job.status === 'RUNNING' && isStale(job.updatedAt))
      return { ...job, status: 'FAILED' as const, errorCode: 'IMPORT_ABANDONED', summary: null };
    // The summary travels with the job rather than behind a second call: it is
    // the whole point of showing somebody the read before it is written, and a
    // console that had to ask twice would show the raw parse in between.
    return {
      ...job,
      summary: job.output ? summarise(job.output as unknown as ImportedReport) : null,
    };
  }

  /**
   * Read the file, deterministically if the layout is one we know.
   *
   * The parser is tried first and the model only sees what it could not read.
   * Paying to re-read a table we can measure exactly would be slower, cost per
   * page, and answer differently on a rerun -- for evidence that ends up
   * justifying a charge.
   */
  private async runExtraction(user: AuthenticatedUser, jobId: string, bytes: Buffer) {
    try {
      const pages = await readPages(bytes);
      let report: ImportedReport | null = null;
      let method = 'DETERMINISTIC';
      let provider: string | null = null;
      let modelId: string | null = null;

      try {
        const parsed = parseReport(pages);
        if (parsed.areas.length >= MINIMUM_AREAS) report = parsed;
      } catch {
        // Falls through to the model: a layout the parser throws on is exactly
        // the case it exists for.
      }

      if (!report) {
        const read = await this.ai.read(
          user.organizationId,
          pages.map((page) => ({
            number: page.number,
            text: page.cells.map((cell) => cell.text).join(' '),
          })),
        );
        if (!read.report) {
          await this.fail(jobId, aiFailureCode(read.reason));
          return;
        }
        report = read.report;
        method = 'AI';
        provider = read.provider;
        modelId = read.modelId;
      }

      await this.prisma.inspectionImportJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          method,
          provider,
          modelId,
          output: JSON.parse(JSON.stringify(report)) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.error({
        event: 'inspection_import_read_failed',
        message: error instanceof Error ? error.message : 'unknown',
      });
      await this.fail(jobId, 'REPORT_NOT_READABLE');
    }
  }

  private async fail(jobId: string, errorCode: string) {
    // try/catch rather than `.catch()`: a throw *constructing* the call — a
    // dead connection, a client that never initialised — happens before there
    // is a promise to attach a handler to, so the chained form does not catch
    // it and the rejection escapes to the floating caller.
    try {
      await this.prisma.inspectionImportJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', errorCode },
      });
    } catch {
      this.logger.error({ event: 'inspection_import_status_not_recorded', jobId });
    }
  }

  /**
   * Write the report in as a move-in inspection.
   *
   * Left un-finalized on purpose. `finalizedAt` freezes evidence permanently,
   * and an import arrives with matches a person has not confirmed yet — so it
   * lands in review, where an administrator finalizes it the same way they
   * would an inspection the app captured.
   */
  async commit(user: AuthenticatedUser, jobId: string) {
    const job = await this.prisma.inspectionImportJob.findFirst({
      where: { id: jobId, organizationId: user.organizationId },
    });
    if (!job) throw new ApplicationError(404, 'IMPORT_JOB_NOT_FOUND', 'Import job was not found.');
    if (job.status !== 'COMPLETED')
      throw new ApplicationError(
        409,
        'IMPORT_NOT_READY',
        'This report has not finished being read yet.',
      );
    if (job.committedAt)
      throw new ApplicationError(409, 'REPORT_ALREADY_IMPORTED', 'This report was already imported.', [
        { inspectionId: job.inspectionId },
      ]);
    if (!job.inspectionId)
      throw new ApplicationError(
        409,
        'IMPORT_HAS_NO_INSPECTION',
        'This job is not attached to an inspection.',
      );

    const report = job.output as unknown as ImportedReport;
    const fingerprint = job.fingerprint;
    // Re-checked at commit, not trusted from the read. Minutes pass while a
    // report is parsed, and an inspection that gained evidence in between must
    // not have it written over.
    // Only the check runs here; `runCommit` reads the building off `target`.
    const target = await this.requireSeedableInspection(user, job.inspectionId);

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

    // Everything above is a check and answers in milliseconds. Everything below
    // reads 73 MB back out of storage, pulls 376 photographs from it, writes
    // each one as an object, and then opens a transaction -- minutes of work
    // that must not sit inside an HTTP request.
    //
    // `main.ts` gives the server a 30-second socket timeout, so it did: Node
    // destroyed the connection at exactly 30.002s, Caddy reported EOF as a 502,
    // and the browser called it a CORS failure because a 502 carries none of
    // the backend's headers. Nothing was written and nothing was logged, which
    // is the worst shape a failure can take.
    //
    // `floor-plan-admin.service.ts` already says why raising the timeout is not
    // the fix: "No timeout value fixes that for arbitrarily complex plans; the
    // work has to leave the request." The reading was moved out and the writing
    // was left behind. This moves the rest.
    void this.runCommit(user, job.id, fingerprint, report, target).catch((error: unknown) => {
      this.logger.error({
        event: 'inspection_import_commit_crashed',
        message: error instanceof Error ? error.message : 'unknown',
      });
    });
    return { jobId: job.id, committing: true as const };
  }

  /**
   * Write the read report in. Never rejects; records its outcome on the job.
   *
   * The console distinguishes the three states from the job alone:
   * `committedAt` set is done, `errorCode` set with the read already COMPLETED
   * is a failed write, and neither is still working.
   */
  private async runCommit(
    user: AuthenticatedUser,
    jobId: string,
    fingerprint: string,
    report: ImportedReport,
    target: Awaited<ReturnType<InspectionImportService['requireSeedableInspection']>>,
  ) {
   try {
    const property = target.building;
    const bytes = await this.storage.get(sourceKey(user.organizationId, fingerprint));
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

      // The inspection already exists; this fills it in. Its identity, its
      // schedule and its place in Jobber are not ours to change -- only the
      // evidence it was always missing, plus a note saying where that came from.
      await tx.inspection.update({
        where: { id: target.id },
        data: {
          source: InspectionSource.IMPORTED_REPORT,
          internalNotes: importNote(report, fingerprint),
        },
      });
      const inspection = { id: target.id };

      let photoCursor = 0;
      for (const area of report.areas) {
        const propertyArea = await this.resolveArea(tx, property.id, area.name, user.id);
        // Upserted rather than created, because the pair is unique and two
        // report areas can resolve to one room. `resolveArea` matches on a
        // normalised name, so a table continued onto a second page under a
        // repeated title, or a model that split one room in two, both hand back
        // the `propertyArea` the previous pass already used. A second `create`
        // raises P2002, and it does so *inside* the transaction -- rolling the
        // whole import back, so one repeated room costs every other area rather
        // than merging into the one already open.
        //
        // The same write is what makes filling in a room that is already
        // attached safe. `requireSeedableInspection` refuses an inspection
        // holding evidence, but it is checked before `storePhotos` writes
        // several hundred objects; an area that appears in that window would
        // otherwise fail the commit outright instead of being filled in.
        const inspectionArea = await tx.inspectionArea.upsert({
          where: {
            inspectionId_propertyAreaId: {
              inspectionId: inspection.id,
              propertyAreaId: propertyArea.id,
            },
          },
          update: { completionStatus: 'COMPLETED', completedAt: new Date() },
          create: {
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

    await this.prisma.inspectionImportJob.update({
      where: { id: jobId },
      data: { committedAt: new Date(), errorCode: null },
    });
    this.logger.log({ event: 'inspection_report_imported', inspectionId });
   } catch (error) {
    this.logger.error({
      event: 'inspection_import_commit_failed',
      message: error instanceof Error ? error.message : 'unknown',
    });
    // Recorded on the job rather than thrown: nobody is waiting on this
    // request any more, so an exception would go nowhere and the console would
    // poll a job that never changes.
    await this.prisma.inspectionImportJob
      .update({ where: { id: jobId }, data: { errorCode: 'IMPORT_WRITE_FAILED' } })
      .catch(() => undefined);
   }
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
   * The inspection this report belongs to, and whether it may be seeded.
   *
   * Only an **empty** one. A record with areas or photographs already has
   * evidence, and replacing that is not importing — it is overwriting somebody
   * else's walkthrough with a document. An empty record has nothing to
   * overwrite, which is exactly why seeding it is safe and why the check is on
   * emptiness rather than on status.
   *
   * Emptiness is also why `finalizedAt` is not an obstacle here. Finalizing
   * freezes evidence, and there is none: the inspection was closed in Jobber
   * because the walk happened, not because anything was recorded on this
   * system. Refusing a finalized shell would refuse every record this feature
   * exists for.
   *
   * Move-in only. The point is a baseline for a later move-out, and seeding a
   * move-out with a move-in report would compare the property against itself.
   */
  private async requireSeedableInspection(user: AuthenticatedUser, inspectionId: string) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId: user.organizationId },
      select: {
        id: true,
        inspectionType: true,
        propertywareBuildingId: true,
        propertywareBuilding: {
          select: {
            id: true,
            name: true,
            addressLine1: true,
            city: true,
            state: true,
            postalCode: true,
          },
        },
        // Areas alone are enough to mean "has evidence": a photograph's
        // `inspectionAreaId` is required, so one cannot exist without an area
        // to hang from.
        _count: { select: { areas: true } },
      },
    });
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    if (inspection.inspectionType !== InspectionType.MOVE_IN)
      throw new ApplicationError(
        409,
        'INSPECTION_NOT_A_MOVE_IN',
        'A report can only be imported into a move-in inspection.',
      );
    if (inspection._count.areas > 0)
      throw new ApplicationError(
        409,
        'INSPECTION_NOT_EMPTY',
        'This inspection already has evidence. A report can only be imported into an empty one.',
      );
    if (!inspection.propertywareBuilding)
      throw new ApplicationError(
        409,
        'INSPECTION_HAS_NO_PROPERTY',
        'This inspection is not linked to a property, so its areas have nowhere to live.',
      );
    return { ...inspection, building: inspection.propertywareBuilding };
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
    /**
     * Pre-sized and written by index, never appended.
     *
     * The commit walks areas in order and reads this positionally through a
     * running `photoCursor`, so the result has to line up with `photos` exactly.
     * Pushing as uploads finished would order it by *completion*, which is
     * arbitrary once several are in flight — and the failure would not be an
     * error, it would be every photograph filed against the wrong room.
     */
    const stored = new Array<{
      storageKey: string;
      width: number;
      height: number;
      sizeBytes: number;
    }>(photos.length);

    /**
     * A fixed set of workers pulling from a shared cursor, rather than fixed
     * slices per worker: photographs vary in size, and a slice that happened to
     * hold the large ones would still be uploading long after the others had
     * finished.
     */
    let next = 0;
    const upload = async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= photos.length) return;
        const photo = photos[index]!;
        // Keyed by the content, so re-running a failed import overwrites its own
        // objects rather than leaving a second copy of every photograph.
        const digest = createHash('sha256').update(photo.bytes).digest('hex').slice(0, 32);
        const storageKey = `${organizationId}/imported/${fingerprint.slice(0, 16)}/${String(index).padStart(4, '0')}-${digest}.jpg`;
        await this.storage.putBytes(storageKey, photo.bytes, 'image/jpeg');
        stored[index] = {
          storageKey,
          width: photo.width,
          height: photo.height,
          sizeBytes: photo.bytes.length,
        };
      }
    };

    // `all`, not `allSettled`: a photograph that cannot be stored is a report
    // that cannot be imported, and the job records the failure. Swallowing it
    // would commit an inspection with a hole in its evidence.
    await Promise.all(
      Array.from({ length: Math.min(PHOTO_UPLOAD_CONCURRENCY, photos.length) }, upload),
    );
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
 * The report's own date is deliberately not written anywhere structural.
 *
 * `scheduledAt` belongs to Jobber, which is the scheduling source of record,
 * and the comparison orders baselines by it — so overwriting it with a date
 * read out of a PDF would move which move-in a later move-out is judged
 * against. The date is kept in the inspection's notes for provenance and
 * nowhere else; `importNote` is where it lands.
 */

/** "Sep 02 2026 01:15:39 PM" as it was written, or null if it will not parse. */
function captureTime(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}
