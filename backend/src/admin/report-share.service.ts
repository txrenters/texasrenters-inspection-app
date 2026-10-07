import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  AreaChecklistItemKind,
  FindingReviewStatus,
  FindingType,
  InspectionAreaCompletionStatus,
  ReportShareKind,
  TranscriptionStatus,
} from '@prisma/client';
import {
  checklistKindFor,
  filterLabel,
  HVAC_FILTERS_SECTION,
  inspectionAssessesFilters,
  SERVICE_PHOTO_AREA,
  RECORDING_ACTION_HEADING,
  type PublicInspectionReport,
  type VisitServicesReport,
} from '@texasrenters/shared';
import { readStoredSummary } from '../technician/recording-summary';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { withSystemTenant, withTenant } from '../database/tenant-context';
import { isAllowedPhotoWidth, resizeImage } from '../common/image-resizing';
import { inspectedAreas } from '../common/inspected-areas';
import { resizedPhotoKeyFor } from '../common/object-storage';
import { PrismaService } from '../common/prisma.service';
import { REPORT_VISIBLE_PHOTO } from '../common/report-visible-photo';
import { InspectionMediaStorageService } from '../technician/inspection-media-storage.service';
import { MailService } from '../mail/mail.service';
import { ComparisonReportService } from './comparison-report.service';
import { ComparisonService } from './comparison.service';

const SHARE_LIFETIME_DAYS = 30;

/** Where each kind of link lives in the web app. */
function sharePathFor(kind: ReportShareKind, token: string) {
  return kind === ReportShareKind.COMPARISON ? `/comparison-report/${token}` : `/report/${token}`;
}

/** What a link answers with when it is not one this route serves: the same as a dead link. */
const NOT_AVAILABLE = () =>
  new ApplicationError(
    404,
    'REPORT_NOT_AVAILABLE',
    'This report link is invalid, expired, or has been revoked.',
  );

const MAX_REPORT_PHOTOS = 300;

/**
 * How each inspection type is named on the printed report.
 *
 * The office's reports carry an "Inspection Template" line — the name of the
 * form the inspector worked from, not the enum. These are the equivalents;
 * `REPORT_TEMPLATE_LABEL_<TYPE>` overrides any of them for a deployment whose
 * wording differs, because this is the organisation's vocabulary rather than
 * ours to fix.
 */
const INSPECTION_TEMPLATE_LABEL: Record<string, string> = {
  MOVE_IN: process.env.REPORT_TEMPLATE_LABEL_MOVE_IN ?? 'Entry Inspection',
  MOVE_OUT: process.env.REPORT_TEMPLATE_LABEL_MOVE_OUT ?? 'Exit Inspection',
  OCCUPIED: process.env.REPORT_TEMPLATE_LABEL_OCCUPIED ?? 'Routine Inspection',
  BACK_TO_MARKET: process.env.REPORT_TEMPLATE_LABEL_BACK_TO_MARKET ?? 'Back to Market Inspection',
  // The name on the office's own HVAC report, which this one follows.
  HVAC: process.env.REPORT_TEMPLATE_LABEL_HVAC ?? 'HVAC Inspection',
  ROOF: process.env.REPORT_TEMPLATE_LABEL_ROOF ?? 'Roof Inspection',
  SUPRA_LOCKBOX_PLACEMENT:
    process.env.REPORT_TEMPLATE_LABEL_SUPRA_LOCKBOX_PLACEMENT ?? 'Supra Lockbox Placement',
  SUPRA_LOCKBOX_REMOVAL:
    process.env.REPORT_TEMPLATE_LABEL_SUPRA_LOCKBOX_REMOVAL ?? 'Supra Lockbox Removal',
  AC_FILTER_DELIVERY: process.env.REPORT_TEMPLATE_LABEL_AC_FILTER_DELIVERY ?? 'AC Filter Delivery',
};

/** A reading as the report prints it: "72 °F", or nothing when none was taken. */
function readingText(value: { toString(): string } | null, unit: string | null): string | null {
  if (value === null) return null;
  const number = Number(value.toString());
  return [Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2))), unit].filter(Boolean).join(' ');
}

/**
 * The HVAC report's Filters table, from the job's AC filter change.
 *
 * Moses, 2026-10-01: the filters are scored on the AC filter change now, not in
 * a Filters section of the inspection (`HVAC_FILTERS_SECTION`). The report keeps
 * printing them where the office's HVAC report always has -- one row per filter
 * the house really has, scored Clean / Undamaged / Working with its comment, and
 * the filter change's photograph beneath. Null for every other job, for an HVAC
 * job that answered nothing, and for one that walked the old Filters section,
 * which prints as it did.
 */
function filtersRoom(
  inspection: {
    inspectionType: string;
    completedAt: Date | null;
    servicesReport: unknown;
    areas: readonly {
      id: string;
      propertyArea: { name: string };
      photos: readonly { id: string }[];
    }[];
  },
  shown: readonly { propertyArea: { name: string } }[],
) {
  if (!inspectionAssessesFilters(inspection.inspectionType)) return null;
  if (shown.some((area) => area.propertyArea.name === HVAC_FILTERS_SECTION)) return null;
  const report = inspection.servicesReport as VisitServicesReport | null;
  const scored = (report?.filters ?? []).filter((filter) => !filter.removed);
  if (!scored.length) return null;
  const photoArea = inspection.areas.find((area) => area.propertyArea.name === SERVICE_PHOTO_AREA.filterChange);
  const photoIds = new Set(scored.flatMap((filter) => (filter.photoId ? [filter.photoId] : [])));
  return {
    room: {
      id: photoArea?.id ?? 'hvac-filters',
      name: HVAC_FILTERS_SECTION as string,
      floorName: null as string | null,
      completionStatus: InspectionAreaCompletionStatus.COMPLETED as InspectionAreaCompletionStatus,
      skipReason: null as string | null,
      completedAt: inspection.completedAt,
      checklist: scored.map((filter, index) => ({
        id: `filter-${index + 1}`,
        label: `Filter ${index + 1} · ${filterLabel(filter)}`,
        keywords: [] as string[],
        isClean: filter.isClean ?? null,
        isUndamaged: filter.isUndamaged ?? null,
        isWorking: filter.isWorking ?? null,
        comment: filter.comment ?? null,
      })),
      // Filters are scored on a form, not narrated on a walkthrough.
      actions: [] as NonNullable<PublicInspectionReport['rooms'][number]['actions']>,
    },
    photos: (photoArea?.photos ?? []).filter((photo) => photoIds.has(photo.id)) as never[],
  };
}

/**
 * A room has one walkthrough and, rarely, a few extra clips; more than this on
 * one room is a retake loop.
 */
const MAX_REPORT_RECORDINGS = 10;

/**
 * What a room prints under its photographs: what it needs, under the office's
 * three headings, from the room's summary (the maintenance team, 2026-10-07).
 *
 * Only while the summary is about the recordings the room has now; a room not
 * summarized yet, or with a recording added since, prints nothing there. The
 * transcript itself is not sent at all -- the report stopped printing it
 * (2026-10-07), and a public link should not carry words nobody reads, which
 * can name a tenant or a way in. The recordings' ids are only compared.
 */
function roomActions(
  recordings: ReadonlyArray<{
    id: string;
    transcriptionJob: { segments: ReadonlyArray<{ text: string }> } | null;
  }>,
  stored: unknown,
): NonNullable<PublicInspectionReport['rooms'][number]['actions']> {
  const spoken = recordings
    .filter((recording) =>
      (recording.transcriptionJob?.segments ?? []).some((segment) => segment.text.trim()),
    )
    .map((recording) => recording.id);
  const read = readStoredSummary(stored, spoken);
  if (!read?.current) return [];
  return read.summary.actions.map((group) => ({
    heading: RECORDING_ACTION_HEADING[group.group],
    items: group.items.map((item) => ({ text: item.text, details: [...item.details] })),
  }));
}

type ChecklistItemRow = {
  id: string;
  label: string;
  keywords: string[];
  kind: AreaChecklistItemKind;
  responseType: string;
  unit: string | null;
};

type ChecklistResponseRow = {
  isClean: boolean | null;
  isUndamaged: boolean | null;
  isWorking: boolean | null;
  comment: string | null;
  textValue: string | null;
  numericValue: { toString(): string } | null;
  checklistItem: ChecklistItemRow;
};

/**
 * The rows a room's table prints, in the form's order.
 *
 * A room checklist prints every live item of the room's form, answered or not,
 * so a room nobody scored still shows what was asked, with blank cells (the
 * office, 2026-10-07). An item answered and since archived keeps its row,
 * after the live ones. The organization-wide lists -- HVAC, occupied -- print
 * their responses as they always have: their rows are sectioned per area by
 * other rules, and a blank reading says nothing.
 */
function checklistRows(
  kind: ReturnType<typeof checklistKindFor>,
  area: {
    checklistResponses: ChecklistResponseRow[];
    propertyArea: { checklistItems?: ChecklistItemRow[] };
  },
): ChecklistResponseRow[] {
  if (kind !== 'ROOM') return area.checklistResponses;
  const answered = new Map(
    area.checklistResponses.map((response) => [response.checklistItem.id, response]),
  );
  const items = area.propertyArea.checklistItems ?? [];
  const live = new Set(items.map((item) => item.id));
  return [
    ...items.map(
      (item) =>
        answered.get(item.id) ?? {
          isClean: null,
          isUndamaged: null,
          isWorking: null,
          comment: null,
          textValue: null,
          numericValue: null,
          checklistItem: item,
        },
    ),
    ...area.checklistResponses.filter((response) => !live.has(response.checklistItem.id)),
  ];
}

/**
 * The rooms in report order, with the filters' table where the HVAC report has
 * always printed it: after the Attic.
 */
function withFiltersRoom<Area extends { propertyArea: { name: string } }, Room>(
  areas: readonly Area[],
  filters: NoInfer<Room> | null,
  view: (area: Area) => Room,
): Room[] {
  const rooms = areas.map(view);
  if (!filters) return rooms;
  const attic = areas.findIndex((area) => area.propertyArea.name === 'Attic');
  rooms.splice(attic + 1, 0, filters);
  return rooms;
}

@Injectable()
export class ReportShareService {
  /**
   * The comparison services come last and optional only so the suites that
   * build this with `new` keep their shape. Both are providers of this module,
   * and `module-graph.spec` proves Nest hands them over; without them a
   * comparison link cannot be issued or opened (`comparisonParts`).
   */
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(MailService) private readonly mailer?: MailService,
    @Optional()
    @Inject(InspectionMediaStorageService)
    private readonly mediaStorage?: InspectionMediaStorageService,
    @Optional()
    @Inject(ComparisonReportService)
    private readonly comparisonReport?: ComparisonReportService,
    @Optional() @Inject(ComparisonService) private readonly comparisons?: ComparisonService,
  ) {}

  /** The comparison services, or a refusal that says what is missing. */
  private comparisonParts() {
    if (!this.comparisonReport || !this.comparisons)
      throw new ApplicationError(
        503,
        'COMPARISON_REPORT_NOT_CONFIGURED',
        'Comparison reports are not available on this server.',
      );
    return { report: this.comparisonReport, comparisons: this.comparisons };
  }

  async createShare(
    user: AuthenticatedUser,
    inspectionId: string,
    recipientEmail?: string,
    kind: ReportShareKind = ReportShareKind.INSPECTION,
  ) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    if (kind === ReportShareKind.COMPARISON) await this.assertComparisonShareable(user, inspectionId);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SHARE_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
    const share = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inspectionReportShare.create({
        data: {
          organizationId: user.organizationId,
          inspectionId,
          createdById: user.id,
          token,
          kind,
          recipientEmail: recipientEmail?.trim().toLowerCase() || null,
          expiresAt,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'REPORT_SHARE_CREATED',
          entityType: 'Inspection',
          entityId: inspectionId,
          metadata: {
            shareId: created.id,
            kind,
            recipientEmail: created.recipientEmail,
            expiresAt: created.expiresAt.toISOString(),
          },
        },
      });
      return created;
    });
    const delivery = share.recipientEmail
      ? await this.mailer?.sendReportShare({
          to: share.recipientEmail,
          reportUrl: this.reportUrl(share.token, kind),
          expiresAt: share.expiresAt,
          kind,
        })
      : undefined;
    return {
      ...this.mapShare(share),
      ...(share.recipientEmail
        ? { emailDeliveryStatus: delivery?.status ?? ('NOT_CONFIGURED' as const) }
        : {}),
    };
  }

  /** The links issued for an inspection, of one kind when asked for one. */
  async listShares(user: AuthenticatedUser, inspectionId: string, kind?: ReportShareKind) {
    const shares = await this.prisma.inspectionReportShare.findMany({
      where: { inspectionId, organizationId: user.organizationId, ...(kind ? { kind } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return shares.map((share) => this.mapShare(share));
  }

  async revokeShare(user: AuthenticatedUser, shareId: string) {
    const share = await this.prisma.inspectionReportShare.findFirst({
      where: { id: shareId, organizationId: user.organizationId },
    });
    if (!share)
      throw new ApplicationError(404, 'REPORT_SHARE_NOT_FOUND', 'Report link was not found.');
    if (share.revokedAt) return this.mapShare(share);
    const updated = await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.inspectionReportShare.update({
        where: { id: share.id },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'REPORT_SHARE_REVOKED',
          entityType: 'Inspection',
          entityId: share.inspectionId,
          metadata: { shareId: share.id },
        },
      });
      return revoked;
    });
    return this.mapShare(updated);
  }

  /**
   * Public, unauthenticated report for homeowners: room completion, APPROVED
   * findings, photos that pass REPORT_VISIBLE_PHOTO, and -- for the comments
   * beside failed checklist rows only -- the titles of the findings the office
   * has not rejected (`checklistNotes`, 2026-10-07). Internal notes, finding
   * descriptions not yet approved, and identifiers stay private.
   */
  async publicReport(token: string) {
    const share = await this.resolveShare(token);
    // A comparison link opens the comparison, not the move-out on its own: a
    // link serves the document it was created for.
    if (share.kind !== ReportShareKind.INSPECTION) throw NOT_AVAILABLE();
    // `withTenant`, not `enterTenant`. The share lookup runs as the system
    // tenant, and `enterWith` inside that helper did not survive back into this
    // continuation — so no `set_config` ran, and every query below was made
    // under an unset tenant. That used to be harmless because the first
    // policies allowed a null tenant; once they were tightened to fail closed,
    // it silently turned every shared report into "This report is not
    // available." Wrapping the reads keeps the scope open across them.
    return withTenant(share.organizationId, () =>
      this.buildPublicReport(share.inspectionId, token),
    );
  }

  /**
   * The public, unauthenticated comparison report: the move-in beside the
   * move-out, for the owner or tenant a link was sent to.
   *
   * Brought up to date first, like the inspection report a link serves: a
   * finding confirmed after the link went out is on the report the next time
   * it is opened. It no longer waits on an approval -- there is none (the
   * office, 2026-10-07; `ComparisonService`).
   */
  async publicComparisonReport(token: string) {
    const share = await this.resolveShare(token);
    if (share.kind !== ReportShareKind.COMPARISON) throw NOT_AVAILABLE();
    // `withTenant` for the reason `publicReport` gives: the share lookup runs as
    // the system tenant, and every read after it must run as the organization.
    return withTenant(share.organizationId, async () => {
      const { report, comparisons } = this.comparisonParts();
      await comparisons.current(share.organizationId, share.inspectionId);
      const comparison = await this.prisma.inspectionComparison.findFirst({
        where: { moveOutInspectionId: share.inspectionId, organizationId: share.organizationId },
        select: { id: true },
      });
      if (!comparison) throw NOT_AVAILABLE();
      return report.reportForShare(share.organizationId, share.inspectionId, token);
    });
  }

  /**
   * A comparison can be sent once there is one: the move-out submitted, and a
   * move-in on record to compare it with.
   *
   * Nothing else stands in the way. Its verdicts come from the technician's
   * checklists and the findings the office confirmed from the recordings, and
   * it keeps itself current (`ComparisonService.current`). Sending it is the
   * person's decision, recorded in the audit log with the link.
   */
  private async assertComparisonShareable(user: AuthenticatedUser, moveOutInspectionId: string) {
    await this.comparisonParts().comparisons.current(user.organizationId, moveOutInspectionId);
    const comparison = await this.prisma.inspectionComparison.findFirst({
      where: { moveOutInspectionId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!comparison)
      throw new ApplicationError(
        404,
        'COMPARISON_NOT_FOUND',
        'There is no comparison for this inspection yet: it is made once the move-out is submitted and its move-in is on record.',
      );
  }

  private async buildPublicReport(inspectionId: string, token: string) {
    const inspection = await this.prisma.inspection.findUnique({
      where: { id: inspectionId },
      select: {
        inspectionType: true,
        status: true,
        scheduledAt: true,
        completedAt: true,
        nextInspectionAlert: true,
        maintenanceComments: true,
        generalComments: true,
        // An HVAC job's filters are scored on its AC filter change: the
        // report's Filters table is read from here (`filtersRoom`).
        servicesReport: true,
        /**
         * Who carried out the inspection, for the report's "Inspector" line.
         *
         * Current assignments only, and all of them: the office's reports name
         * more than one person on a job, and a superseded assignment names
         * whoever *used* to hold it — printing that would credit the wrong
         * technician on a document a tenant may be shown.
         */
        assignments: {
          where: { isCurrent: true },
          orderBy: { assignedAt: 'asc' as const },
          select: { technician: { select: { displayName: true } } },
        },
        // Who signed the report off. Preferred over the link's creator: a
        // report can be shared more than once, by different people, and the
        // name on it should be whoever took responsibility for the content.
        finalizedBy: { select: { displayName: true } },
        propertywareUnit: { select: { name: true } },
        propertywareBuilding: {
          select: { name: true, addressLine1: true, city: true, state: true, postalCode: true },
        },
        areas: {
          orderBy: { propertyArea: { inspectionOrder: 'asc' } },
          take: 100,
          select: {
            id: true,
            propertyAreaId: true,
            completionStatus: true,
            skipReason: true,
            completedAt: true,
            // The recordings summarized for the report (2026-10-07), printed in
            // place of the narration word for word while it is current.
            recordingSummary: true,
            // source with the name: whether the area is the inspection's at all.
            propertyArea: {
              select: {
                name: true,
                source: true,
                floor: { select: { name: true } },
                /**
                 * The room's own checklist, scored or not.
                 *
                 * The office's report prints every row of a room's form and
                 * leaves the cells blank where nothing was assessed; it never
                 * drops the row. Reading only the responses left eleven of a
                 * move-out's 22 rooms with no table at all (2026-10-07), which
                 * the office read as the verdicts having been removed. Live items only: an archived item still prints when
                 * it was answered, through its response below.
                 */
                checklistItems: {
                  where: { kind: AreaChecklistItemKind.ROOM, archivedAt: null },
                  orderBy: [{ sortOrder: 'asc' as const }, { label: 'asc' as const }],
                  take: 100,
                  select: { id: true, label: true, keywords: true, kind: true, responseType: true, unit: true },
                },
              },
            },
            /**
             * The condition checklist as the technician scored it.
             *
             * Ordered by the item's own sortOrder so the report prints rows in
             * the sequence an administrator authored, which is the order the
             * office's existing reports use.
             *
             * Archived items are deliberately still included: the report is a
             * record of what was assessed at the time, and dropping a row
             * because someone later tidied the checklist would silently edit
             * history a tenant may already have been shown.
             */
            checklistResponses: {
              orderBy: [
                { checklistItem: { sortOrder: 'asc' as const } },
                { checklistItem: { label: 'asc' as const } },
              ],
              select: {
                isClean: true,
                isUndamaged: true,
                isWorking: true,
                comment: true,
                // An occupied room's answer ("Clean", "Good") lives here, with
                // all three axes null.
                textValue: true,
                // An HVAC reading, printed with its unit.
                numericValue: true,
                // `keywords` travels with the row so the report can attach the
                // finding that explains a failed axis. They already exist to
                // recognise the item in a transcript ("wall", "ceiling"), and
                // that is precisely the vocabulary an AI-authored finding
                // categorises itself with.
                checklistItem: {
                  select: { id: true, label: true, keywords: true, kind: true, responseType: true, unit: true },
                },
              },
            },
            photos: {
              where: REPORT_VISIBLE_PHOTO,
              orderBy: [{ captureType: 'asc' }, { sequenceNumber: 'asc' }, { capturedAt: 'asc' }],
              take: MAX_REPORT_PHOTOS,
              select: {
                id: true,
                label: true,
                notes: true,
                capturedAt: true,
                // A stamp is only printed on a time whose origin is known.
                captureTimeSource: true,
                width: true,
                height: true,
                // The caption the printed report uses. Every photograph in the
                // office's report is titled with the checklist item it
                // evidences, so the table states the verdict and the
                // photographs beneath prove it item by item.
                checklistItem: { select: { label: true } },
              },
            },
            /**
             * The room's transcribed recordings, only to tell whether its summary is
             * still about them: their ids, and whether anything was said. Never printed.
             */
            media: {
              where: { transcriptionJob: { status: TranscriptionStatus.COMPLETED } },
              take: MAX_REPORT_RECORDINGS,
              select: {
                id: true,
                transcriptionJob: {
                  select: {
                    segments: { where: { text: { not: '' } }, take: 5, select: { text: true } },
                  },
                },
              },
            },
          },
        },
        findings: {
          where: { reviewStatus: FindingReviewStatus.APPROVED },
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: {
            id: true,
            propertyAreaId: true,
            title: true,
            description: true,
            category: true,
            severity: true,
            comparisonResult: true,
            baselineCondition: true,
            propertyArea: { select: { name: true } },
          },
        },
      },
    });
    /**
     * The comments beside failed checklist rows: every finding the office has
     * not rejected, by title only (the office, 2026-10-07 -- print them
     * straight away, keep them short). Neither a room's summary nor a "no
     * change" note: beside an N it would read as the opposite of the row.
     */
    const notes = inspection
      ? await this.prisma.inspectionFinding.findMany({
          where: {
            inspectionId,
            reviewStatus: { not: FindingReviewStatus.REJECTED },
            findingType: { not: FindingType.NO_CHANGE },
          },
          orderBy: { createdAt: 'asc' },
          // A 22-room move-out filed 347 (2026-10-07); at 300 the last rooms
          // walked lost their comments.
          take: 1000,
          select: {
            propertyAreaId: true,
            title: true,
            category: true,
            propertyArea: { select: { name: true } },
          },
        })
      : [];
    if (!inspection)
      throw new ApplicationError(404, 'REPORT_NOT_AVAILABLE', 'This report is not available.');
    const building = inspection.propertywareBuilding;
    /**
     * The rooms the inspection inspected (`inspectedAreas`). The job's "AC
     * filters" photo area printed as a room of its own, of filters, in a report
     * about the property's condition (the office, 2026-09-29).
     */
    const areas = inspectedAreas(inspection.inspectionType, inspection.areas);
    // Findings carry the catalog area id; rooms are per-inspection areas. Map
    // one to the other so the view model can group without guessing by name.
    const roomIdByPropertyArea = new Map(areas.map((area) => [area.propertyAreaId, area.id]));
    const photoView = (photo: (typeof areas)[number]['photos'][number], roomId: string) => ({
      id: photo.id,
      roomId,
      // The item name wins over free text: it is what the printed report
      // captions with, and a technician's ad-hoc label is the fallback for
      // a photograph that documents the room rather than one item.
      label: photo.checklistItem?.label ?? photo.label,
      checklistItem: photo.checklistItem?.label ?? null,
      notes: photo.notes,
      capturedAt: photo.capturedAt,
      captureTimeSource: photo.captureTimeSource,
      width: photo.width,
      height: photo.height,
      contentPath: `/api/v1/reports/${encodeURIComponent(token)}/photos/${photo.id}`,
    });
    const filters = filtersRoom(inspection, areas);
    const checklistKind = checklistKindFor(inspection.inspectionType);
    return {
      brand: this.brand(),
      property: {
        name: building?.name ?? 'Property',
        addressLine1: building?.addressLine1 ?? '',
        unitName: inspection.propertywareUnit?.name ?? null,
        city: building?.city ?? '',
        state: building?.state ?? '',
        postalCode: building?.postalCode ?? '',
      },
      inspection: {
        type: inspection.inspectionType,
        status: inspection.status,
        scheduledAt: inspection.scheduledAt,
        completedAt: inspection.completedAt,
        // Null rather than a placeholder when nobody is assigned: the report
        // should not claim an inspector it does not have.
        /**
         * The office, then the field — the order the printed report uses.
         *
         * "Office" is whoever signed the report off, falling back to whoever
         * issued this link when it has not been finalized. A public report has
         * no viewer to ask, so the acting account has to be captured at issue
         * time rather than read at view time.
         *
         * Deduplicated: an administrator who is also the assigned technician
         * would otherwise be printed twice.
         */
        /**
         * The field only. The office's name used to lead this line -- whoever
         * signed the report off, or issued the link -- and the maintenance
         * team asked for it to come off (2026-10-07): the report names who
         * walked the property, and an administrator generating the link is
         * not that.
         */
        inspector:
          [
            ...new Set(
              inspection.assignments
                .map((entry) => entry.technician.displayName)
                .filter((name): name is string => Boolean(name?.trim())),
            ),
          ].join(' / ') || null,
        templateLabel: INSPECTION_TEMPLATE_LABEL[inspection.inspectionType] ?? null,
      },
      // The report's closing block. Nulls travel through as nulls so the
      // renderers can omit a heading rather than print one over nothing.
      closing: {
        nextInspectionAlert: inspection.nextInspectionAlert,
        maintenanceComments: inspection.maintenanceComments,
        generalComments: inspection.generalComments,
      },
      rooms: withFiltersRoom(areas, filters?.room ?? null, (area) => ({
        id: area.id,
        name: area.propertyArea.name,
        floorName: area.propertyArea.floor?.name ?? null,
        completionStatus: area.completionStatus,
        skipReason: area.skipReason,
        completedAt: area.completedAt,
        // Nulls are carried through rather than coerced: the report prints an
        // empty cell for an unassessed axis, and a false would claim a defect
        // the technician never recorded.
        checklist: checklistRows(checklistKind, area).map((response) => ({
          id: response.checklistItem.id,
          label: response.checklistItem.label,
          keywords: response.checklistItem.keywords,
          isClean: response.isClean,
          isUndamaged: response.isUndamaged,
          isWorking: response.isWorking,
          comment: response.comment,
          /*
           * The answer, for anything that is not a three-axis verdict.
           *
           * An occupied room's question, and an HVAC reading or line of text.
           * The office's HVAC report prints a section's table and nothing else
           * of what was measured, so a reading is printed as the answer on its
           * row -- "72 °F" -- rather than as three blank cells. Room checklists
           * are all three-axis verdicts and print as they always have.
           */
          ...(response.checklistItem.kind === AreaChecklistItemKind.OCCUPIED
            ? { responseType: response.checklistItem.responseType, textValue: response.textValue }
            : response.checklistItem.kind === AreaChecklistItemKind.AIR_CONDITIONING &&
                response.checklistItem.responseType !== 'STATUS'
              ? {
                  responseType: response.checklistItem.responseType,
                  textValue:
                    response.checklistItem.responseType === 'READING'
                      ? readingText(response.numericValue, response.checklistItem.unit)
                      : response.textValue,
                }
              : {}),
        })),
        actions: roomActions(area.media ?? [], area.recordingSummary),
      })),
      findings: inspection.findings.map((finding) => ({
        id: finding.id,
        roomId: roomIdByPropertyArea.get(finding.propertyAreaId) ?? null,
        roomName: finding.propertyArea.name,
        title: finding.title,
        description: finding.description,
        category: finding.category,
        severity: finding.severity,
        comparisonResult: finding.comparisonResult,
        baselineCondition: finding.baselineCondition,
      })),
      checklistNotes: notes.map((note) => ({
        roomId: roomIdByPropertyArea.get(note.propertyAreaId) ?? null,
        roomName: note.propertyArea.name,
        category: note.category,
        title: note.title,
      })),
      photos: [
        ...areas.flatMap((area) => area.photos.map((photo) => photoView(photo, area.id))),
        ...(filters ? filters.photos.map((photo) => photoView(photo, filters.room.id)) : []),
      ],
      generatedAt: new Date(),
    };
  }

  /**
   * Photo bytes for a shared report. The share token is the only credential, so
   * the photo must belong to that share's inspection *and* independently pass
   * the same visibility rule — a valid token for one inspection must never read
   * another's evidence, and must never reach an unapproved finding's photo.
   */
  /**
   * One route for both kinds of link, rather than a second `@Res()` handler:
   * this is the only streamed route in the backend, and it once took the whole
   * API down on every request. Keeping the crash surface at one hardened place
   * is worth more than a tidier URL.
   *
   * A comparison link may ask for a photograph from either inspection it sets
   * side by side, so its scope is the pair -- and no further.
   */
  async publicPhoto(token: string, photoId: string, width?: number) {
    const share = await this.resolveShare(token);
    return withTenant(share.organizationId, async () => {
      const inspectionIds =
        share.kind === ReportShareKind.COMPARISON
          ? await this.comparisonInspectionIds(share.inspectionId, share.organizationId)
          : [share.inspectionId];
      return this.loadPublicPhoto(inspectionIds, photoId, width);
    });
  }

  /** The two inspections a comparison link sets side by side. */
  private async comparisonInspectionIds(moveOutInspectionId: string, organizationId: string) {
    const comparison = await this.prisma.inspectionComparison.findFirst({
      where: { moveOutInspectionId, organizationId },
      select: { moveInInspectionId: true, moveOutInspectionId: true },
    });
    if (!comparison)
      throw new ApplicationError(404, 'REPORT_PHOTO_NOT_FOUND', 'This photo is not available.');
    return [comparison.moveInInspectionId, comparison.moveOutInspectionId];
  }

  private async loadPublicPhoto(inspectionIds: string[], photoId: string, width?: number) {
    if (!this.mediaStorage)
      throw new ApplicationError(
        503,
        'INSPECTION_MEDIA_STORAGE_NOT_CONFIGURED',
        'Inspection media storage is not configured.',
      );
    const photo = await this.prisma.inspectionPhoto.findFirst({
      where: { id: photoId, inspectionId: { in: inspectionIds }, AND: REPORT_VISIBLE_PHOTO },
      select: { id: true, storageKey: true, mimeType: true },
    });
    if (!photo)
      throw new ApplicationError(404, 'REPORT_PHOTO_NOT_FOUND', 'This photo is not available.');
    if (width === undefined || !isAllowedPhotoWidth(width))
      return { bytes: await this.mediaStorage.get(photo.storageKey), mimeType: photo.mimeType };
    return { bytes: await this.resizedPhoto(photo.storageKey, width), mimeType: 'image/jpeg' };
  }

  /**
   * A width-limited copy, cached beside the original under a derived key so the
   * re-encode happens once per photo rather than once per view. A cache write
   * that fails is not an error — the caller still gets the resized bytes.
   */
  private async resizedPhoto(storageKey: string, width: number) {
    const variantKey = resizedPhotoKeyFor(storageKey, width);
    try {
      return await this.mediaStorage!.get(variantKey);
    } catch {
      // Not generated yet.
    }
    const original = await this.mediaStorage!.get(storageKey);
    const resized = await resizeImage(original, width);
    await this.mediaStorage!.putBytes(variantKey, resized, 'image/jpeg').catch(() => undefined);
    return resized;
  }

  /** Resolves a share token to its inspection, or 404s indistinguishably. */
  /**
   * Resolve a homeowner's share token, and adopt the organization it names.
   *
   * The token IS the credential here — `GET /reports/:token` carries no user —
   * so the lookup itself has no organization and runs as the system. Everything
   * after it does: the share tells us whose inspection this is, and the rest of
   * the request is scoped to that organization rather than left unscoped.
   *
   * `enterTenant` rather than wrapping the callers, so the two public methods
   * need no restructuring: it binds the rest of this request's async context.
   */
  private async resolveShare(token: string) {
    const share = await withSystemTenant(() =>
      this.prisma.inspectionReportShare.findUnique({
        where: { token },
        select: {
          inspectionId: true,
          organizationId: true,
          kind: true,
          expiresAt: true,
          revokedAt: true,
          // Whoever issued this link — the logged-in account at the moment the
          // report went out. A public report has no viewer to ask.
          createdBy: { select: { displayName: true } },
        },
      }),
    );
    if (!share || share.revokedAt || share.expiresAt < new Date()) throw NOT_AVAILABLE();
    // A row without a kind predates the column, and is what its default says.
    return { ...share, kind: share.kind ?? ReportShareKind.INSPECTION };
  }

  /** Letterhead. Deployment-level branding; every field is env-overridable. */
  private brand() {
    return {
      name: process.env.REPORT_BRAND_NAME ?? 'TexasRenters.com',
      addressLine1: process.env.REPORT_BRAND_ADDRESS_LINE1 ?? null,
      addressLine2: process.env.REPORT_BRAND_ADDRESS_LINE2 ?? null,
      phone: process.env.REPORT_BRAND_PHONE ?? null,
      email: process.env.REPORT_BRAND_EMAIL ?? null,
    };
  }

  private mapShare(share: {
    id: string;
    inspectionId: string;
    token: string;
    kind: ReportShareKind;
    recipientEmail: string | null;
    expiresAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: share.id,
      inspectionId: share.inspectionId,
      token: share.token,
      kind: share.kind,
      sharePath: sharePathFor(share.kind, share.token),
      recipientEmail: share.recipientEmail,
      expiresAt: share.expiresAt,
      revokedAt: share.revokedAt,
      createdAt: share.createdAt,
    };
  }

  private reportUrl(token: string, kind: ReportShareKind) {
    const origin = (process.env.WEB_APP_ORIGIN ?? 'http://localhost:5454').replace(/\/$/, '');
    return `${origin}${sharePathFor(kind, token)}`;
  }
}
