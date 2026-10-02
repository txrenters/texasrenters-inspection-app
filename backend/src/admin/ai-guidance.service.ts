import { Inject, Injectable } from '@nestjs/common';
import type { FindingRejectReason } from '@prisma/client';
import {
  FindingReviewStatus,
  FindingSource,
  Prisma,
  TranscriptionStatus,
  VisualCheckStatus,
} from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { ROOM_SUMMARY_WHERE } from '../technician/room-summary';

/** As the database allows; the console says so before it is reached. */
export const MAX_GUIDANCE_LENGTH = 8000;

/** How far back the AI's lessons and the scorecard look. */
const LESSON_WINDOW_DAYS = 120;
const MAX_REJECTED_LESSONS = 6;
const MAX_EDITED_LESSONS = 4;

/** A reject reason, in words a model and a person both read the same way. */
export const REJECT_REASON_LABEL: Record<FindingRejectReason, string> = {
  NOT_IN_VIDEO: 'not visible in the video',
  ALREADY_AT_MOVE_IN: 'already there at move-in',
  NORMAL_WEAR: 'normal wear and tear',
  DUPLICATE: 'a duplicate of another finding',
  WRONG_ROOM: 'in a different room',
  NOT_A_PROBLEM: 'not a problem',
  OTHER: 'another reason',
};

/** "Bedroom 2" and "bedroom" are the same kind of room, for choosing lessons. */
export function roomKind(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type EditedValue = {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

function describeVersion(fields: Record<string, unknown> | undefined) {
  if (!fields) return '';
  const extra = [fields.severity, fields.findingType].filter(Boolean).join(', ');
  return `"${String(fields.title ?? '')}"${extra ? ` (${extra})` : ''}`;
}

/**
 * Lines the analysis is shown about how the office decided similar AI
 * findings: a rejection with its reason, a correction from what the AI wrote
 * to what the office kept.
 *
 * Pure, and given the rows rather than querying, so the choice is testable:
 * the same kind of room first, newest first, one line per title.
 */
export function lessonLines(
  rows: Array<{
    status: FindingReviewStatus;
    reason: string | null;
    reasonCode: FindingRejectReason | null;
    editedValue: unknown;
    finding: { title: string; roomName: string };
  }>,
  roomName: string,
) {
  const kind = roomKind(roomName);
  const ordered = [
    ...rows.filter((row) => roomKind(row.finding.roomName) === kind),
    ...rows.filter((row) => roomKind(row.finding.roomName) !== kind),
  ];
  const seen = new Set<string>();
  const rejected: string[] = [];
  const edited: string[] = [];
  for (const row of ordered) {
    const key = `${row.status}:${row.finding.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.status === FindingReviewStatus.REJECTED && rejected.length < MAX_REJECTED_LESSONS) {
      const why = row.reasonCode ? REJECT_REASON_LABEL[row.reasonCode] : 'no reason chosen';
      const note = row.reason?.trim() ? ` Office note: ${row.reason.trim().slice(0, 200)}` : '';
      rejected.push(`- Rejected as ${why}: "${row.finding.title}" (${row.finding.roomName}).${note}`);
    }
    if (row.status === FindingReviewStatus.EDITED && edited.length < MAX_EDITED_LESSONS) {
      const value = (row.editedValue ?? {}) as EditedValue;
      if (value.before && value.after)
        edited.push(
          `- Corrected: ${describeVersion(value.before)} became ${describeVersion(value.after)} (${row.finding.roomName}).`,
        );
    }
  }
  return [...rejected, ...edited];
}

/**
 * What the office teaches the AI: its house rules, and its own past decisions.
 *
 * The rules are the office's words about what counts as damage, wear and
 * cleaning, kept in versions so a scorecard can say which version did better.
 * The lessons are recent rejections (with the reason chosen) and corrections,
 * shown to the analysis as examples. Neither can loosen a guardrail: findings
 * stay suggestions and the code's checks run whatever the prompt says.
 */
@Injectable()
export class AiGuidanceService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The rules in use: the newest version, or null when there are none. */
  async current(organizationId: string) {
    const latest = await this.prisma.aiGuidanceVersion.findFirst({
      where: { organizationId },
      orderBy: { version: 'desc' },
      select: { version: true, text: true, createdAt: true },
    });
    return latest?.text.trim() ? latest : null;
  }

  async history(organizationId: string) {
    const versions = await this.prisma.aiGuidanceVersion.findMany({
      where: { organizationId },
      orderBy: { version: 'desc' },
      take: 20,
      select: { version: true, text: true, createdAt: true, createdById: true },
    });
    const authorIds = [...new Set(versions.flatMap((row) => (row.createdById ? [row.createdById] : [])))];
    const authors = authorIds.length
      ? await this.prisma.userProfile.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const name = new Map(authors.map((author) => [author.id, author.displayName]));
    return {
      current: versions[0]
        ? { version: versions[0].version, text: versions[0].text }
        : { version: 0, text: '' },
      versions: versions.map((row) => ({
        version: row.version,
        createdAt: row.createdAt.toISOString(),
        createdByName: row.createdById ? (name.get(row.createdById) ?? null) : null,
        length: row.text.length,
      })),
    };
  }

  /**
   * Save the rules as a new version. Nothing is overwritten: an earlier version
   * stays as the record of what analyses before this one ran under.
   */
  async save(user: AuthenticatedUser, text: string) {
    const trimmed = text.trim();
    if (trimmed.length > MAX_GUIDANCE_LENGTH)
      throw new ApplicationError(
        422,
        'AI_GUIDANCE_TOO_LONG',
        `House rules are limited to ${MAX_GUIDANCE_LENGTH} characters.`,
      );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const saved = await this.prisma.$transaction(async (tx) => {
          const latest = await tx.aiGuidanceVersion.findFirst({
            where: { organizationId: user.organizationId },
            orderBy: { version: 'desc' },
            select: { version: true, text: true },
          });
          if (latest && latest.text === trimmed) return latest;
          const created = await tx.aiGuidanceVersion.create({
            data: {
              organizationId: user.organizationId,
              version: (latest?.version ?? 0) + 1,
              text: trimmed,
              createdById: user.id,
            },
            select: { version: true, text: true },
          });
          await tx.auditLog.create({
            data: {
              organizationId: user.organizationId,
              actorUserId: user.id,
              action: 'AI_GUIDANCE_UPDATED',
              entityType: 'OrganizationAiSettings',
              entityId: user.organizationId,
              metadata: { version: created.version, length: trimmed.length },
            },
          });
          return created;
        });
        return this.history(user.organizationId).then((history) => ({ ...history, saved }));
      } catch (error) {
        // Two saves at once both read the same latest version; the unique
        // index refuses the second, which tries again on top of the first.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
        throw error;
      }
    }
    throw new ApplicationError(409, 'AI_GUIDANCE_CONFLICT', 'The house rules changed while saving. Try again.');
  }

  /**
   * The office's recent decisions on AI findings elsewhere, as lessons for the
   * analysis of one room. Never this inspection's own: those are already in
   * the prompt as decided findings.
   */
  async lessons(organizationId: string, roomName: string, excludeInspectionId: string) {
    const since = new Date(Date.now() - LESSON_WINDOW_DAYS * 24 * 60 * 60_000);
    const rows = await this.prisma.findingReview.findMany({
      where: {
        status: { in: [FindingReviewStatus.REJECTED, FindingReviewStatus.EDITED] },
        createdAt: { gte: since },
        finding: {
          inspection: { organizationId },
          inspectionId: { not: excludeInspectionId },
          NOT: { ...ROOM_SUMMARY_WHERE },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 80,
      select: {
        status: true,
        reason: true,
        reasonCode: true,
        editedValue: true,
        finding: { select: { title: true, propertyArea: { select: { name: true } } } },
      },
    });
    return lessonLines(
      rows.map((row) => ({
        ...row,
        finding: { title: row.finding.title, roomName: row.finding.propertyArea.name },
      })),
      roomName,
    );
  }

  /**
   * Recent recordings the office has decided findings on, to try draft rules
   * against: the decisions are what a draft can be compared with.
   */
  async samples(organizationId: string) {
    const media = await this.prisma.inspectionMedia.findMany({
      where: {
        organizationId,
        transcriptionJob: { is: { status: TranscriptionStatus.COMPLETED } },
        findings: {
          some: {
            reviewStatus: { in: [FindingReviewStatus.APPROVED, FindingReviewStatus.REJECTED] },
            NOT: { ...ROOM_SUMMARY_WHERE },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: {
        id: true,
        createdAt: true,
        inspectionId: true,
        inspectionArea: {
          select: {
            propertyArea: { select: { name: true } },
            inspection: {
              select: {
                inspectionType: true,
                propertywareBuilding: { select: { name: true } },
              },
            },
          },
        },
        _count: { select: { findings: { where: { NOT: { ...ROOM_SUMMARY_WHERE } } } } },
      },
    });
    return media.map((row) => ({
      mediaId: row.id,
      inspectionId: row.inspectionId,
      roomName: row.inspectionArea.propertyArea.name,
      propertyName: row.inspectionArea.inspection.propertywareBuilding?.name ?? null,
      inspectionType: row.inspectionArea.inspection.inspectionType,
      recordedAt: row.createdAt.toISOString(),
      findings: row._count.findings,
    }));
  }

  /**
   * How the AI's findings fared with the office.
   *
   * From the decisions people already made, so it costs nothing to read:
   * kept as written, kept with corrections, rejected and why. Split by where a
   * finding came from (narration or the AI's own eyes), by what the AI saw in
   * the video, and by the version that wrote it (prompt, model, house rules),
   * which is how a change to the rules is judged.
   */
  async scorecard(organizationId: string, days = 90) {
    const since = new Date(Date.now() - days * 24 * 60 * 60_000);
    const findings = await this.prisma.inspectionFinding.findMany({
      where: {
        inspection: { organizationId },
        createdAt: { gte: since },
        NOT: { ...ROOM_SUMMARY_WHERE },
      },
      // The newest, should a period ever hold more than this.
      orderBy: { createdAt: 'desc' },
      take: 10_000,
      select: {
        source: true,
        reviewStatus: true,
        visualStatus: true,
        videoTimestampStart: true,
        videoTimestampEnd: true,
        aiAnalysisJob: { select: { promptVersion: true, modelId: true, guidanceVersion: true } },
        reviews: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true, reasonCode: true },
        },
        frameSuggestions: { select: { status: true } },
      },
    });

    type Tally = { findings: number; pending: number; kept: number; corrected: number; rejected: number };
    const blank = (): Tally => ({ findings: 0, pending: 0, kept: 0, corrected: 0, rejected: 0 });
    const count = (tally: Tally, finding: (typeof findings)[number]) => {
      tally.findings += 1;
      const latest = finding.reviews[0]?.status;
      if (finding.reviewStatus === FindingReviewStatus.PENDING_REVIEW) tally.pending += 1;
      else if (finding.reviewStatus === FindingReviewStatus.REJECTED) tally.rejected += 1;
      // A correction is approved with an EDITED review beside it; a finding
      // whose own status is EDITED predates that and means the same.
      else if (
        latest === FindingReviewStatus.EDITED ||
        finding.reviewStatus === FindingReviewStatus.EDITED
      )
        tally.corrected += 1;
      else if (finding.reviewStatus === FindingReviewStatus.APPROVED) tally.kept += 1;
    };

    const totals = blank();
    const bySource: Record<string, Tally> = {};
    const byVersion = new Map<string, Tally & { promptVersion: string; modelId: string; guidanceVersion: number | null }>();
    const rejectReasons: Record<string, number> = {};
    const visual = { checked: 0, seen: 0, notSeen: 0, unclear: 0, notSeenRejected: 0, notSeenKept: 0, seenRejected: 0 };
    const photos = { offered: 0, accepted: 0, allDismissed: 0 };
    const timing = { narration: 0, withMoment: 0 };

    for (const finding of findings) {
      count(totals, finding);
      count((bySource[finding.source] ??= blank()), finding);
      const job = finding.aiAnalysisJob;
      if (job) {
        const key = `${job.promptVersion}|${job.modelId}|${job.guidanceVersion ?? ''}`;
        const entry =
          byVersion.get(key) ??
          { ...blank(), promptVersion: job.promptVersion, modelId: job.modelId, guidanceVersion: job.guidanceVersion };
        count(entry, finding);
        byVersion.set(key, entry);
      }
      if (finding.reviewStatus === FindingReviewStatus.REJECTED) {
        const code = finding.reviews[0]?.reasonCode ?? 'UNSPECIFIED';
        rejectReasons[code] = (rejectReasons[code] ?? 0) + 1;
      }
      if (finding.visualStatus) {
        visual.checked += 1;
        const rejected = finding.reviewStatus === FindingReviewStatus.REJECTED;
        const kept = finding.reviewStatus === FindingReviewStatus.APPROVED;
        if (finding.visualStatus === VisualCheckStatus.VISIBLE) {
          visual.seen += 1;
          if (rejected) visual.seenRejected += 1;
        } else if (finding.visualStatus === VisualCheckStatus.NOT_VISIBLE) {
          visual.notSeen += 1;
          if (rejected) visual.notSeenRejected += 1;
          if (kept) visual.notSeenKept += 1;
        } else visual.unclear += 1;
      }
      if (finding.frameSuggestions.length) {
        photos.offered += 1;
        if (finding.frameSuggestions.some((row) => row.status === 'ACCEPTED')) photos.accepted += 1;
        else if (finding.frameSuggestions.every((row) => row.status === 'DISMISSED')) photos.allDismissed += 1;
      }
      if (finding.source === FindingSource.NARRATION) {
        timing.narration += 1;
        if (finding.videoTimestampStart || finding.videoTimestampEnd) timing.withMoment += 1;
      }
    }

    return {
      window: { days, since: since.toISOString(), truncated: findings.length === 10_000 },
      totals,
      bySource,
      rejectReasons,
      visual,
      photos,
      timing,
      byVersion: [...byVersion.values()].sort((left, right) => right.findings - left.findings),
    };
  }
}
