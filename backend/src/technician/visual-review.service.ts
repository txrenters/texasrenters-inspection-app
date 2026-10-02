import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  AiAnalysisStatus,
  AiProvider,
  BaselineVisualStatus,
  ComparisonResult,
  FindingReviewStatus,
  FindingSource,
  FindingType,
  FrameSuggestionStatus,
  InspectionType,
  PhotoCaptureType,
  PhotoStorageStatus,
  ResponsibilityClassification,
  Severity,
  VisualCheckStatus,
} from '@prisma/client';
import { z } from 'zod';

import { AiGuidanceService } from '../admin/ai-guidance.service';
import {
  AiProviderSettingsService,
  type AiTokenUsage,
  type ResolvedAiConfiguration,
} from '../admin/ai-provider-settings.service';
import { ComparisonService } from '../admin/comparison.service';
import { findingMatchesChecklistItem } from '../common/checklist-item-match';
import { ApplicationError } from '../common/errors';
import { resizeImage } from '../common/image-resizing';
import { resizedPhotoKeyFor } from '../common/object-storage';
import { PrismaService } from '../common/prisma.service';
import { CloudflareStreamService } from '../media/cloudflare-stream.service';
import { houseRulesLines } from './house-rules';
import { InspectionMediaStorageService } from './inspection-media-storage.service';
import { ROOM_SUMMARY_WHERE } from './room-summary';

/**
 * The AI looks at the recording a finding came from.
 *
 * Until this, every finding was written from the technician's narration alone:
 * the model never saw a frame. On the 2026-10-01 Flower Gate move-out a
 * reviewer had to find each finding in the video by hand, and nothing told
 * them when the narration claimed something the video did not show.
 *
 * Two passes per recording, which a trial on that move-out settled:
 *
 * 1. **Scan.** Frames every few seconds at low resolution. For each finding:
 *    is it visible, and in which frames? Plus up to five problems the frames
 *    show that nobody mentioned. Frame choice in the trial was right on every
 *    finding checked; asked about a ceiling fan that was not there, the model
 *    said it could not see one rather than inventing it.
 * 2. **Close look.** For each finding the scan found, its sharpest frame at
 *    full height: confirm it, and box where it is. The scan's own boxes were
 *    beside the damage as often as on it; this pass put them on it. On a
 *    move-out, the matching move-in photographs go with it: was it already
 *    there? A problem the scan spotted but the close look cannot confirm is
 *    dropped, so a new finding needs both passes to agree.
 *
 * Everything here is a suggestion. Suggested frames sit in their own table
 * until a person files one as the finding's photograph; spotted problems are
 * findings awaiting review like any other; nothing is approved, charged or
 * printed by this. It may take a tenant lean *off* a finding the move-in
 * photograph shows was already there, never put one on.
 */

/**
 * Recorded on the analysis job, so a finding can be traced to the prompt that wrote it.
 * vision-2: the office's house rules decide what counts as a problem worth spotting.
 * vision-3: the technician's photos of the room are looked at with the frames.
 */
export const VISUAL_PROMPT_VERSION = 'vision-3';

/** Frames looked at in the scan, however long the recording. */
const MAX_SCAN_FRAMES = 90;
/** Seconds between scan frames on a short recording. */
const MIN_SCAN_STEP_SECONDS = 3;
const SCAN_FRAME_HEIGHT = 640;
const CLOSE_FRAME_HEIGHT = 1080;
/** Findings and spotted problems given a close look, at most. */
const MAX_CLOSE_TARGETS = 15;
const MAX_SPOTTED = 5;
const MAX_BASELINE_PHOTOS_PER_TARGET = 2;
const BASELINE_PHOTO_WIDTH = 1000;
/**
 * The technician's own photos of the room the scan is shown, at most. Sharper
 * than any frame of a moving phone video, so a small chip or a nail hole the
 * video blurs can still be seen; bounded because each one is paid for.
 */
const MAX_ROOM_PHOTOS = 8;
/** The photos kept on a finding as where it was seen. */
const MAX_PHOTOS_PER_FINDING = 3;
const CALL_TIMEOUT_MS = 180_000;
/** Long enough for every frame of one review to be fetched. */
const FRAME_TOKEN_TTL_SECONDS = 15 * 60;

/** The seconds the scan looks at: evenly through the recording, at most 90. */
export function scanTimes(durationSeconds: number) {
  const duration = Math.max(0, Math.floor(durationSeconds));
  if (duration < 2) return [0];
  const step = Math.max(MIN_SCAN_STEP_SECONDS, Math.ceil(duration / MAX_SCAN_FRAMES));
  const times: number[] = [];
  for (let second = 1; second < duration; second += step) times.push(second);
  return times;
}

/** "T021": how a frame is named to the model, by its second. */
export function frameLabel(seconds: number) {
  return `T${String(Math.round(seconds)).padStart(3, '0')}`;
}

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/**
 * A box the model gave, made safe to store: fractions of the frame, inside it,
 * and big enough to mean something. Null for anything else; a box is an aid to
 * the reviewer's eye and a wrong one is worse than none.
 */
export function normalizeBox(value: unknown) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const numbers = value.map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) return null;
  const x = Math.min(1, Math.max(0, numbers[0]));
  const y = Math.min(1, Math.max(0, numbers[1]));
  const width = Math.min(1 - x, Math.max(0, numbers[2]));
  const height = Math.min(1 - y, Math.max(0, numbers[3]));
  if (width < 0.01 || height < 0.01) return null;
  return { x, y, width, height };
}

/**
 * Whether a move-in photograph is of the item a finding is about, by the
 * checklist item it is filed under. The rule is shared with the move-in
 * comparison, which shows each finding beside its item.
 */
export const photoMatchesFinding = findingMatchesChecklistItem;

const visibility = z.enum(['VISIBLE', 'NOT_VISIBLE', 'UNCLEAR']).catch('UNCLEAR');

export const scanResponseSchema = z.object({
  findings: z
    .array(
      z.object({
        ref: z.string(),
        visible: visibility,
        frames: z.array(z.string()).catch([]).default([]),
        observation: z.string().max(1000).catch('').default(''),
      }),
    )
    .catch([])
    .default([]),
  additional: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        description: z.string().min(1).max(1000),
        category: z.string().min(1).max(80),
        kind: z.enum(['DAMAGE', 'CLEANING', 'ITEMS_LEFT', 'MAINTENANCE']).catch('DAMAGE'),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH']).catch('LOW'),
        frames: z.array(z.string()).min(1),
        observation: z.string().max(1000).catch('').default(''),
      }),
    )
    .catch([])
    .default([]),
});

export const closeResponseSchema = z.object({
  items: z
    .array(
      z.object({
        ref: z.string(),
        visible: z.boolean().catch(false),
        box: z.unknown().optional(),
        observation: z.string().max(1000).catch('').default(''),
        atMoveIn: z.enum(['PRESENT', 'ABSENT', 'CANT_TELL']).optional().catch(undefined),
        moveInNote: z.string().max(1000).optional().catch(undefined),
      }),
    )
    .catch([])
    .default([]),
});

function parseJsonObject(text: string) {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped);
}

/** What the model is shown, before it is put in either provider's shape. */
type Part = { kind: 'text'; text: string } | { kind: 'image'; bytes: Buffer; mimeType: string };

type CheckedFinding = {
  id: string;
  title: string;
  description: string;
  category: string;
  start: number;
  end: number;
  reviewStatus: FindingReviewStatus;
  possibleResponsibility: ResponsibilityClassification;
};

type Target = {
  ref: string;
  /** The finding, or null for a problem the scan spotted. */
  finding: CheckedFinding | null;
  spotted: z.infer<typeof scanResponseSchema>['additional'][number] | null;
  title: string;
  category: string;
  /** Best first. */
  seconds: number[];
  /** The technician's photos it was seen in, best first. */
  photoIds: string[];
  observation: string;
};

export function describeChecklistAnswer(answer: {
  isClean: boolean | null;
  isUndamaged: boolean | null;
  isWorking: boolean | null;
}) {
  const axis = (value: boolean | null, yes: string, no: string) =>
    value === null ? 'not assessed' : value ? yes : no;
  return `${axis(answer.isClean, 'clean', 'NOT clean')}, ${axis(
    answer.isUndamaged,
    'undamaged',
    'DAMAGED',
  )}, ${axis(answer.isWorking, 'working', 'NOT working')}`;
}

/**
 * The scan's instructions. Refs (F1…) stand for findings so the model never
 * handles an id; frames are named by their second.
 */
export function scanPrompt(input: {
  roomName: string;
  inspectionType: string;
  frameCount: number;
  /** The technician's still photos of the room shown after the frames. */
  photoCount?: number;
  checklist: Array<{ label: string; answer: string; comment: string | null }>;
  findings: Array<{ ref: string; title: string; description: string; start: number; end: number }>;
  decided: Array<{ title: string; reviewStatus: string }>;
  /** The office's house rules: what counts as a problem worth listing at all. */
  houseRules?: string | null;
}) {
  const moveIn = input.inspectionType === InspectionType.MOVE_IN;
  return [
    'You are checking a property inspection video for TexasRenters, a property manager.',
    `You see ${input.frameCount} still frames from a phone walkthrough of one room, in time order. Each frame is preceded by its label and time, like "T021 (0:21)".`,
    ...(input.photoCount
      ? [
          `After the frames come ${input.photoCount} still photographs the technician took in the same room, each preceded by its label, like "P1 (photo: Doors and locks)". They are sharper than the frames: use them for small details, and cite them by label exactly as you cite frames.`,
        ]
      : []),
    `Room: ${input.roomName}. Inspection type: ${input.inspectionType}.`,
    ...houseRulesLines(input.houseRules ?? null),
    ...(input.checklist.length
      ? [
          'The technician recorded this checklist for the room (authoritative):',
          ...input.checklist.map(
            (item) => `- ${item.label}: ${item.answer}${item.comment ? ` — note: ${item.comment}` : ''}`,
          ),
        ]
      : []),
    ...(input.findings.length
      ? [
          "Findings written from the technician's spoken narration, which the office must review:",
          ...input.findings.map((finding) => {
            const when =
              finding.start || finding.end
                ? `narrated around ${clock(finding.start)}–${clock(finding.end)}`
                : 'no narration time known';
            return `${finding.ref}: ${finding.title} — ${finding.description} (${when})`;
          }),
        ]
      : ['No findings were written from the narration for this room.']),
    ...(input.decided.length
      ? [
          'The office has already decided these; do not list them as additional problems:',
          ...input.decided.map((finding) => `- ${finding.title} (${finding.reviewStatus.toLowerCase()})`),
        ]
      : []),
    '',
    'Task A. For every finding, look through the frames and decide:',
    '- visible: VISIBLE if at least one frame plainly shows the condition described; NOT_VISIBLE if frames show the relevant item or surface clearly and it does not look as described; UNCLEAR if the item never appears clearly enough to tell.',
    '- frames: up to 3 frame or photo labels that show it best, best first. Empty unless VISIBLE.',
    '- observation: one or two sentences on exactly what the best frame shows: the item, where it is, its approximate size, its condition. Only what can be seen; never restate the narration as if seen.',
    `Task B. List up to ${MAX_SPOTTED} other problems that are clearly visible but not covered by any finding: damage, stains, holes, chips, cracks, scuffs, missing or broken parts, torn screens, dirt or items left behind. Small details count: nail and screw holes, small chips, hairline cracks, water marks. Report only what is unmistakable in a frame, never a guess from blur.`,
    '  Each: title, description, category (a short noun such as Walls), kind (DAMAGE|CLEANING|ITEMS_LEFT|MAINTENANCE), severity (LOW|MEDIUM|HIGH), frames (best first), observation.',
    moveIn
      ? 'This is a MOVE-IN: everything you see is the condition the tenant receives, to be recorded.'
      : 'Do not judge who is responsible or whether anything is new; that is not your job here.',
    'Frames come from a moving phone camera and many are blurred: judge from the sharpest ones.',
    'Return JSON only, no prose: {"findings":[{"ref":"F1","visible":"VISIBLE","frames":["T021"],"observation":"..."}],"additional":[{"title":"...","description":"...","category":"...","kind":"DAMAGE","severity":"LOW","frames":["T040"],"observation":"..."}]}',
  ].join('\n');
}

/** The close look's instructions; each target's frame and move-in photographs follow its ref. */
export function closePrompt(input: { roomName: string; moveInDate: string | null }) {
  return [
    `Each block below is about one condition in a ${input.roomName}: a reference and what the condition is, then one sharp frame from the walkthrough${
      input.moveInDate
        ? `, and sometimes one or two photographs of the same item from the move-in inspection of ${input.moveInDate}`
        : ''
    }.`,
    'For each reference:',
    '- visible: true only if the frame plainly shows the condition.',
    '- box: the tightest box around the condition itself (the holes, the chip, the stain), not the whole object it is on, as [x, y, width, height] in fractions 0-1 of the frame, x and y from the top-left. Null when not visible.',
    '- observation: one sentence on what the box contains: the item, where it is, approximate size, condition.',
    ...(input.moveInDate
      ? [
          '- atMoveIn, only when move-in photographs follow: PRESENT if a move-in photograph plainly shows the same condition at the same spot; ABSENT if a move-in photograph clearly shows that same spot in good condition; CANT_TELL otherwise (another angle, too far, unclear).',
          '- moveInNote: one sentence on what the move-in photograph shows at that spot.',
        ]
      : []),
    'Return JSON only, no prose: {"items":[{"ref":"F1","visible":true,"box":[0.1,0.2,0.1,0.05],"observation":"...","atMoveIn":"PRESENT","moveInNote":"..."}]}',
  ].join('\n');
}

@Injectable()
export class VisualReviewService {
  private readonly logger = new Logger(VisualReviewService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AiProviderSettingsService) private readonly aiSettings: AiProviderSettingsService,
    @Optional() @Inject(CloudflareStreamService) private readonly stream?: CloudflareStreamService,
    @Optional()
    @Inject(InspectionMediaStorageService)
    private readonly storage?: InspectionMediaStorageService,
    @Optional() @Inject(ComparisonService) private readonly comparison?: ComparisonService,
    @Optional() @Inject(AiGuidanceService) private readonly guidance?: AiGuidanceService,
  ) {}

  /** Whether the office has switched it on. */
  enabled(organizationId: string) {
    return this.aiSettings.visualReviewEnabled(organizationId);
  }

  /**
   * Look at one recording. Null when there is nothing to look at: no Stream
   * video, not encoded, or too short. A finalized inspection is looked at too:
   * its findings are still the office's to decide (see
   * `AdminService.reviewFinding`), and no decision already taken is changed.
   */
  async review(mediaId: string, organizationId: string) {
    const media = await this.prisma.inspectionMedia.findFirst({
      where: { id: mediaId, organizationId },
      select: {
        id: true,
        inspectionId: true,
        streamUid: true,
        readyAt: true,
        durationSeconds: true,
        inspectionAreaId: true,
        inspectionArea: {
          select: {
            propertyArea: { select: { id: true, name: true } },
            inspection: { select: { inspectionType: true } },
          },
        },
      },
    });
    if (!media?.streamUid || !media.readyAt || media.durationSeconds < 2) return null;
    if (!this.stream?.customerCode) return null;

    const inspectionType = media.inspectionArea.inspection.inspectionType;
    const roomName = media.inspectionArea.propertyArea.name;
    const [findingRows, decidedRows, answers] = await Promise.all([
      // This recording's findings from the narration, except those the office
      // rejected: there is nothing to look for in a finding ruled out.
      this.prisma.inspectionFinding.findMany({
        where: {
          inspectionMediaId: media.id,
          source: FindingSource.NARRATION,
          reviewStatus: { not: FindingReviewStatus.REJECTED },
          NOT: { ...ROOM_SUMMARY_WHERE },
        },
        orderBy: { createdAt: 'asc' },
        take: MAX_CLOSE_TARGETS + 10,
        select: {
          id: true,
          title: true,
          description: true,
          category: true,
          videoTimestampStart: true,
          videoTimestampEnd: true,
          reviewStatus: true,
          possibleResponsibility: true,
        },
      }),
      // Everything decided in the room, so the scan does not raise it again.
      this.prisma.inspectionFinding.findMany({
        where: {
          inspectionId: media.inspectionId,
          propertyAreaId: media.inspectionArea.propertyArea.id,
          reviewStatus: { not: FindingReviewStatus.PENDING_REVIEW },
          NOT: { ...ROOM_SUMMARY_WHERE },
        },
        select: { title: true, reviewStatus: true },
        take: 40,
      }),
      this.prisma.inspectionAreaChecklistResponse.findMany({
        where: {
          inspectionAreaId: media.inspectionAreaId,
          OR: [
            { isClean: { not: null } },
            { isUndamaged: { not: null } },
            { isWorking: { not: null } },
          ],
        },
        select: {
          isClean: true,
          isUndamaged: true,
          isWorking: true,
          comment: true,
          checklistItem: { select: { label: true } },
        },
      }),
    ]);
    const findings: CheckedFinding[] = findingRows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      start: row.videoTimestampStart,
      end: row.videoTimestampEnd,
      reviewStatus: row.reviewStatus,
      possibleResponsibility: row.possibleResponsibility,
    }));

    const configuration = await this.aiSettings.resolve(organizationId);
    const houseRules = (await this.guidance?.current(organizationId)) ?? null;
    const thumbnail = this.thumbnailBase(media.streamUid);
    const times = scanTimes(media.durationSeconds);
    const [scanFrames, roomPhotos] = await Promise.all([
      this.fetchFrames(thumbnail, times, SCAN_FRAME_HEIGHT),
      this.roomPhotos(media.inspectionAreaId),
    ]);
    if (scanFrames.size < Math.ceil(times.length / 2))
      throw new ApplicationError(
        502,
        'VISUAL_REVIEW_FRAMES_UNAVAILABLE',
        'Cloudflare did not return enough frames of this recording to look at.',
      );

    const job = await this.prisma.aiAnalysisJob.create({
      data: {
        inspectionMediaId: media.id,
        status: AiAnalysisStatus.RUNNING,
        provider: configuration.provider.toLowerCase(),
        modelId: configuration.modelId,
        promptVersion: VISUAL_PROMPT_VERSION,
        schemaVersion: '1',
        guidanceVersion: houseRules?.version ?? null,
      },
    });
    const usage: AiTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const add = (more: AiTokenUsage) => {
      usage.inputTokens += more.inputTokens;
      usage.outputTokens += more.outputTokens;
      usage.totalTokens += more.totalTokens;
    };

    try {
      // ── Pass 1: the scan ────────────────────────────────────────────────
      const refs = new Map(findings.map((finding, index) => [`F${index + 1}`, finding]));
      const scanParts: Part[] = [
        {
          kind: 'text',
          text: scanPrompt({
            roomName,
            inspectionType,
            frameCount: scanFrames.size,
            photoCount: roomPhotos.length,
            checklist: answers.map((answer) => ({
              label: answer.checklistItem.label,
              answer: describeChecklistAnswer(answer),
              comment: answer.comment,
            })),
            findings: [...refs].map(([ref, finding]) => ({ ref, ...finding })),
            decided: decidedRows,
            houseRules: houseRules?.text ?? null,
          }),
        },
      ];
      for (const [second, bytes] of scanFrames) {
        scanParts.push({ kind: 'text', text: `${frameLabel(second)} (${clock(second)})` });
        scanParts.push({ kind: 'image', bytes, mimeType: 'image/jpeg' });
      }
      roomPhotos.forEach((photo, index) => {
        scanParts.push({
          kind: 'text',
          text: `P${index + 1} (photo${photo.label ? `: ${photo.label}` : ''})`,
        });
        scanParts.push({ kind: 'image', bytes: photo.bytes, mimeType: 'image/jpeg' });
      });
      const scanReply = await this.ask(configuration, scanParts);
      add(scanReply.usage);
      const scan = scanResponseSchema.parse(parseJsonObject(scanReply.text));

      const known = new Map([...scanFrames.keys()].map((second) => [frameLabel(second), second]));
      const secondsOf = (labels: string[]) =>
        labels.flatMap((label) => (known.has(label) ? [known.get(label)!] : []));
      const photoLabels = new Map(roomPhotos.map((photo, index) => [`P${index + 1}`, photo]));
      const photosOf = (labels: string[]) =>
        labels.flatMap((label) => (photoLabels.has(label) ? [photoLabels.get(label)!.id] : []));

      const verdicts = new Map<
        string,
        { status: VisualCheckStatus; observation: string; photoIds: string[] }
      >();
      const targets: Target[] = [];
      for (const entry of scan.findings) {
        const finding = refs.get(entry.ref);
        if (!finding) continue;
        const seconds = secondsOf(entry.frames);
        const photoIds = photosOf(entry.frames);
        // Seen, but in nothing it could name: not something to assert.
        const status =
          entry.visible === 'VISIBLE' && !seconds.length && !photoIds.length
            ? VisualCheckStatus.UNCLEAR
            : VisualCheckStatus[entry.visible];
        verdicts.set(finding.id, {
          status,
          observation: entry.observation,
          photoIds: status === VisualCheckStatus.VISIBLE ? photoIds : [],
        });
        if (status === VisualCheckStatus.VISIBLE)
          targets.push({
            ref: entry.ref,
            finding,
            spotted: null,
            title: finding.title,
            category: finding.category,
            seconds,
            photoIds,
            observation: entry.observation,
          });
      }
      scan.additional.slice(0, MAX_SPOTTED).forEach((spotted, index) => {
        const seconds = secondsOf(spotted.frames);
        const photoIds = photosOf(spotted.frames);
        if (seconds.length || photoIds.length)
          targets.push({
            ref: `A${index + 1}`,
            finding: null,
            spotted,
            title: spotted.title,
            category: spotted.category,
            seconds,
            photoIds,
            observation: spotted.observation,
          });
      });
      const close = targets.slice(0, MAX_CLOSE_TARGETS);

      // ── Pass 2: the close look ──────────────────────────────────────────
      const baseline =
        inspectionType === InspectionType.MOVE_OUT
          ? await this.baselinePhotos(media.inspectionId, media.inspectionArea.propertyArea.id)
          : null;
      const sharpest = new Map<string, { atMs: number; bytes: Buffer }>();
      // Targets the close look sees in a photo, the video never having shown them.
      const lookedAtPhoto = new Set<string>();
      const baselineFor = new Map<string, string[]>();
      const closeParts: Part[] = [
        {
          kind: 'text',
          text: closePrompt({
            roomName,
            moveInDate: baseline ? baseline.scheduledAt.toISOString().slice(0, 10) : null,
          }),
        },
      ];
      for (const target of close) {
        const frame = target.seconds.length
          ? await this.sharpestFrame(thumbnail, target.seconds[0], media.durationSeconds)
          : null;
        const photo = frame ? null : roomPhotos.find((entry) => entry.id === target.photoIds[0]);
        if (!frame && !photo) continue;
        if (frame) sharpest.set(target.ref, frame);
        else lookedAtPhoto.add(target.ref);
        closeParts.push({
          kind: 'text',
          text: `${target.ref}: ${target.title}. ${target.observation}${frame ? '' : ' (a photograph of the room, not a frame)'}`,
        });
        closeParts.push({ kind: 'image', bytes: (frame ?? photo)!.bytes, mimeType: 'image/jpeg' });
        const photos = (baseline?.photos ?? [])
          .filter((photo) => photoMatchesFinding(target, photo.checklistItem))
          .slice(0, MAX_BASELINE_PHOTOS_PER_TARGET);
        const loaded: string[] = [];
        for (const photo of photos) {
          const bytes = await this.photoBytes(photo.storageKey);
          if (!bytes) continue;
          if (!loaded.length) closeParts.push({ kind: 'text', text: `${target.ref} at move-in:` });
          closeParts.push({ kind: 'image', bytes, mimeType: 'image/jpeg' });
          loaded.push(photo.id);
        }
        if (loaded.length) baselineFor.set(target.ref, loaded);
      }
      const confirmed = new Map<string, z.infer<typeof closeResponseSchema>['items'][number]>();
      if (sharpest.size || lookedAtPhoto.size) {
        const closeReply = await this.ask(configuration, closeParts);
        add(closeReply.usage);
        for (const item of closeResponseSchema.parse(parseJsonObject(closeReply.text)).items)
          confirmed.set(item.ref, item);
      }

      // ── Keep it ─────────────────────────────────────────────────────────
      const now = new Date();
      const findingUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
      const suggestions: Array<Record<string, unknown>> = [];
      const spottedRows: Array<Record<string, unknown>> = [];

      const suggestionsFor = (findingId: string, target: Target, box: ReturnType<typeof normalizeBox>, observation: string) => {
        const best = sharpest.get(target.ref);
        const moments = [
          ...(best ? [{ atMs: best.atMs, box, observation }] : []),
          ...target.seconds.slice(1, 3).map((second) => ({ atMs: second * 1000, box: null, observation: null })),
        ];
        moments.forEach((moment, rank) =>
          suggestions.push({
            organizationId,
            inspectionId: media.inspectionId,
            findingId,
            inspectionMediaId: media.id,
            atMs: moment.atMs,
            rank,
            boxX: moment.box?.x ?? null,
            boxY: moment.box?.y ?? null,
            boxWidth: moment.box?.width ?? null,
            boxHeight: moment.box?.height ?? null,
            observation: moment.observation,
          }),
        );
      };

      for (const finding of findings) {
        const verdict = verdicts.get(finding.id);
        if (!verdict) continue;
        const target = close.find((entry) => entry.finding?.id === finding.id);
        const look = target ? confirmed.get(target.ref) : undefined;
        // Seen in the scan but not on a sharp look: not something to assert --
        // unless a photograph showed it, which is sharper than either frame.
        const status =
          verdict.status === VisualCheckStatus.VISIBLE &&
          target &&
          (sharpest.has(target.ref) || lookedAtPhoto.has(target.ref)) &&
          look?.visible === false &&
          !(sharpest.has(target.ref) && verdict.photoIds.length)
            ? VisualCheckStatus.UNCLEAR
            : verdict.status;
        const baselineStatus = look?.atMoveIn
          ? look.atMoveIn === 'PRESENT'
            ? BaselineVisualStatus.PRESENT_AT_MOVE_IN
            : look.atMoveIn === 'ABSENT'
              ? BaselineVisualStatus.NOT_AT_MOVE_IN
              : BaselineVisualStatus.CANT_TELL
          : null;
        findingUpdates.push({
          id: finding.id,
          data: {
            visualStatus: status,
            visualObservation: (look?.visible ? look.observation : '') || verdict.observation || null,
            visualCheckedAt: now,
            visualPhotoIds:
              status === VisualCheckStatus.VISIBLE
                ? verdict.photoIds.slice(0, MAX_PHOTOS_PER_FINDING)
                : [],
            baselineVisualStatus: baselineStatus,
            baselineVisualNote: baselineStatus ? (look?.moveInNote ?? null) : null,
            baselinePhotoIds: baselineStatus && target ? (baselineFor.get(target.ref) ?? []) : [],
            // The move-in photograph shows it already: no tenant lean on an
            // undecided finding. Never the other way round.
            ...(baselineStatus === BaselineVisualStatus.PRESENT_AT_MOVE_IN &&
            finding.reviewStatus === FindingReviewStatus.PENDING_REVIEW &&
            finding.possibleResponsibility === ResponsibilityClassification.TENANT_REVIEW_REQUIRED
              ? { possibleResponsibility: ResponsibilityClassification.UNDETERMINED }
              : {}),
          },
        });
        // Frames to suggest only where the video showed it: a finding a photo
        // confirmed is not offered the frame a sharp look could not see it in.
        if (
          target &&
          status === VisualCheckStatus.VISIBLE &&
          sharpest.has(target.ref) &&
          look?.visible !== false
        )
          suggestionsFor(
            finding.id,
            target,
            look?.visible ? normalizeBox(look.box) : null,
            (look?.visible ? look.observation : '') || target.observation,
          );
      }

      for (const target of close) {
        if (!target.spotted) continue;
        const look = confirmed.get(target.ref);
        // Two passes must agree before the AI adds a finding of its own.
        if (!look?.visible || !(sharpest.has(target.ref) || lookedAtPhoto.has(target.ref))) continue;
        const id = randomUUID();
        const best = sharpest.get(target.ref);
        // Seen only in a photograph: it cites no moment of the recording.
        const second = best ? Math.round(best.atMs / 1000) : 0;
        const baselineStatus =
          look.atMoveIn === 'PRESENT'
            ? BaselineVisualStatus.PRESENT_AT_MOVE_IN
            : look.atMoveIn === 'ABSENT'
              ? BaselineVisualStatus.NOT_AT_MOVE_IN
              : look.atMoveIn === 'CANT_TELL'
                ? BaselineVisualStatus.CANT_TELL
                : null;
        spottedRows.push({
          id,
          inspectionId: media.inspectionId,
          propertyAreaId: media.inspectionArea.propertyArea.id,
          inspectionMediaId: media.id,
          aiAnalysisJobId: job.id,
          source: FindingSource.AI_VISION,
          findingType:
            inspectionType === InspectionType.MOVE_IN
              ? FindingType.EXISTING_CONDITION
              : target.spotted.kind === 'DAMAGE'
                ? FindingType.POSSIBLE_NEW_DAMAGE
                : FindingType.MAINTENANCE,
          category: target.spotted.category,
          title: target.spotted.title,
          description: target.spotted.description,
          baselineCondition: '',
          // Seen, not compared: nothing here says whether it is new.
          comparisonResult: ComparisonResult.INSUFFICIENT_DATA,
          videoTimestampStart: second,
          videoTimestampEnd: best ? Math.min(media.durationSeconds, second + 2) : 0,
          severity: Severity[target.spotted.severity],
          // Never a tenant lean from the AI's own eyes.
          possibleResponsibility: ResponsibilityClassification.UNDETERMINED,
          confidence: 0.5,
          recommendedReview:
            'Spotted in the video by the AI; the technician did not mention it. Check the frame before approving.',
          reviewStatus: FindingReviewStatus.PENDING_REVIEW,
          visualStatus: VisualCheckStatus.VISIBLE,
          visualObservation: look.observation || target.observation,
          visualCheckedAt: now,
          visualPhotoIds: target.photoIds.slice(0, MAX_PHOTOS_PER_FINDING),
          baselineVisualStatus: baselineStatus,
          baselineVisualNote: baselineStatus ? (look.moveInNote ?? null) : null,
          baselinePhotoIds: baselineStatus ? (baselineFor.get(target.ref) ?? []) : [],
        });
        if (best)
          suggestionsFor(id, target, normalizeBox(look.box), look.observation || target.observation);
      }

      await this.prisma.$transaction(
        async (tx) => {
          for (const update of findingUpdates)
            await tx.inspectionFinding.update({ where: { id: update.id }, data: update.data });
          // This recording's earlier suggestions nobody acted on, and the
          // problems it spotted that nobody decided, are replaced. A person's
          // decision on either is kept.
          await tx.findingFrameSuggestion.deleteMany({
            where: { inspectionMediaId: media.id, status: FrameSuggestionStatus.SUGGESTED },
          });
          await tx.inspectionFinding.deleteMany({
            where: {
              inspectionMediaId: media.id,
              source: FindingSource.AI_VISION,
              reviewStatus: FindingReviewStatus.PENDING_REVIEW,
            },
          });
          if (spottedRows.length)
            await tx.inspectionFinding.createMany({ data: spottedRows as never });
          if (suggestions.length)
            await tx.findingFrameSuggestion.createMany({
              data: suggestions as never,
              // A moment a person already accepted or dismissed stays as they left it.
              skipDuplicates: true,
            });
        },
        { timeout: 20_000 },
      );
      await this.prisma.aiAnalysisJob.update({
        where: { id: job.id },
        data: { status: AiAnalysisStatus.COMPLETED },
      });
      await this.aiSettings.recordUsage(organizationId, configuration, 'VISUAL_REVIEW', usage, media.id);
      return {
        checked: findingUpdates.length,
        suggested: suggestions.length,
        spotted: spottedRows.length,
        usage,
      };
    } catch (error) {
      await this.prisma.aiAnalysisJob
        .update({ where: { id: job.id }, data: { status: AiAnalysisStatus.FAILED } })
        .catch(() => undefined);
      if (usage.totalTokens)
        await this.aiSettings
          .recordUsage(organizationId, configuration, 'VISUAL_REVIEW', usage, media.id)
          .catch(() => undefined);
      throw error;
    }
  }

  /** A signed still URL for any moment of the recording, short-lived. */
  private thumbnailBase(streamUid: string) {
    const { token } = this.stream!.signPlaybackToken(streamUid, FRAME_TOKEN_TTL_SECONDS);
    return `https://customer-${this.stream!.customerCode}.cloudflarestream.com/${token}/thumbnails/thumbnail.jpg`;
  }

  private async frame(base: string, seconds: number, height: number) {
    const url = `${base}?time=${seconds.toFixed(1)}s&height=${height}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (response?.ok) return Buffer.from(await response.arrayBuffer());
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
    return null;
  }

  /** Frames by second, six at a time; a frame Cloudflare will not render is left out. */
  private async fetchFrames(base: string, seconds: number[], height: number) {
    const frames = new Map<number, Buffer>();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, seconds.length) }, async () => {
        while (next < seconds.length) {
          const second = seconds[next++];
          const bytes = await this.frame(base, second, height);
          if (bytes) frames.set(second, bytes);
        }
      }),
    );
    return new Map([...frames].sort(([left], [right]) => left - right));
  }

  /**
   * The sharpest of three frames around a moment, at full height.
   *
   * A phone walkthrough blurs as it moves. The largest JPEG of the three is the
   * one with the most detail in it, which for a still from moving video is the
   * least blurred: cheap, and good enough to choose between neighbours.
   */
  private async sharpestFrame(base: string, seconds: number, durationSeconds: number) {
    const candidates = [seconds - 0.5, seconds, seconds + 0.5].filter(
      (second) => second >= 0 && second <= durationSeconds,
    );
    let best: { atMs: number; bytes: Buffer } | null = null;
    for (const second of candidates) {
      const bytes = await this.frame(base, second, CLOSE_FRAME_HEIGHT);
      if (bytes && (!best || bytes.byteLength > best.bytes.byteLength))
        best = { atMs: Math.round(second * 1000), bytes };
    }
    return best;
  }

  /**
   * The move-in's photographs of the room the comparison pairs with this one,
   * with the checklist item each was filed under. Null without a move-in, or
   * without storage to read them from.
   */
  private async baselinePhotos(moveOutInspectionId: string, propertyAreaId: string) {
    if (!this.comparison || !this.storage) return null;
    const baseline = await this.comparison.baselineAreaFor(moveOutInspectionId, propertyAreaId);
    if (!baseline?.area) return null;
    const photos = await this.prisma.inspectionPhoto.findMany({
      where: {
        inspectionId: baseline.inspectionId,
        inspectionArea: { propertyAreaId: baseline.area.propertyAreaId },
        storageStatus: PhotoStorageStatus.UPLOADED,
        checklistItemId: { not: null },
      },
      orderBy: [{ sequenceNumber: 'asc' }, { capturedAt: 'asc' }],
      take: 60,
      select: {
        id: true,
        storageKey: true,
        checklistItem: { select: { label: true, keywords: true } },
      },
    });
    return photos.length ? { scheduledAt: baseline.scheduledAt, photos } : null;
  }

  /**
   * The technician's own photos of the room, with what each was filed under.
   * Not the stills cut from this recording: the scan has the video already.
   */
  private async roomPhotos(inspectionAreaId: string) {
    if (!this.storage) return [];
    const rows = await this.prisma.inspectionPhoto.findMany({
      where: {
        inspectionAreaId,
        storageStatus: PhotoStorageStatus.UPLOADED,
        captureType: { not: PhotoCaptureType.VIDEO_FRAME_SNAPSHOT },
      },
      orderBy: [{ sequenceNumber: 'asc' }, { capturedAt: 'asc' }],
      take: MAX_ROOM_PHOTOS,
      select: { id: true, storageKey: true, label: true, checklistItem: { select: { label: true } } },
    });
    const loaded = await Promise.all(
      rows.map(async (row) => {
        const bytes = await this.photoBytes(row.storageKey);
        return bytes
          ? { id: row.id, bytes, label: row.label?.trim() || row.checklistItem?.label || null }
          : null;
      }),
    );
    return loaded.filter((photo): photo is NonNullable<typeof photo> => photo !== null);
  }

  /** A photograph at the width the console already caches, or null. */
  private async photoBytes(storageKey: string) {
    if (!this.storage) return null;
    const variant = await this.storage
      .get(resizedPhotoKeyFor(storageKey, BASELINE_PHOTO_WIDTH))
      .catch(() => null);
    if (variant) return variant;
    const original = await this.storage.get(storageKey).catch(() => null);
    return original ? resizeImage(original, BASELINE_PHOTO_WIDTH) : null;
  }

  private async ask(configuration: ResolvedAiConfiguration, parts: Part[]) {
    const response =
      configuration.provider === AiProvider.ANTHROPIC
        ? await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            headers: {
              'content-type': 'application/json',
              'x-api-key': configuration.apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: configuration.modelId,
              max_tokens: 6_000,
              // As for floor plans: no sampling parameters, and the whole
              // budget for the answer.
              thinking: { type: 'disabled' },
              messages: [
                {
                  role: 'user',
                  content: parts.map((part) =>
                    part.kind === 'text'
                      ? { type: 'text', text: part.text }
                      : {
                          type: 'image',
                          source: {
                            type: 'base64',
                            media_type: part.mimeType,
                            data: part.bytes.toString('base64'),
                          },
                        },
                  ),
                },
              ],
            }),
          })
        : await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${configuration.apiKey}`,
            },
            body: JSON.stringify({
              model: configuration.modelId,
              // Reasoning tokens come out of this budget too.
              max_output_tokens: 12_000,
              reasoning: { effort: 'low' },
              input: [
                {
                  role: 'user',
                  content: parts.map((part) =>
                    part.kind === 'text'
                      ? { type: 'input_text', text: part.text }
                      : {
                          type: 'input_image',
                          image_url: `data:${part.mimeType};base64,${part.bytes.toString('base64')}`,
                          // Small details are the point.
                          detail: 'high',
                        },
                  ),
                },
              ],
            }),
          });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw this.providerError(response.status, payload);
    return configuration.provider === AiProvider.ANTHROPIC
      ? this.readAnthropic(payload)
      : this.readOpenAi(payload);
  }

  private readAnthropic(payload: unknown) {
    const parsed = z
      .object({
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
        usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
      })
      .parse(payload);
    const inputTokens = parsed.usage?.input_tokens ?? 0;
    const outputTokens = parsed.usage?.output_tokens ?? 0;
    return {
      text: parsed.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('\n'),
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    };
  }

  private readOpenAi(payload: unknown) {
    const parsed = z
      .object({
        output: z.array(
          z.object({
            type: z.string(),
            content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
          }),
        ),
        usage: z
          .object({ input_tokens: z.number(), output_tokens: z.number(), total_tokens: z.number() })
          .optional(),
      })
      .parse(payload);
    return {
      text: parsed.output
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text ?? '')
        .join('\n'),
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        totalTokens: parsed.usage?.total_tokens ?? 0,
      },
    };
  }

  private providerError(status: number, payload: unknown) {
    const message =
      (payload as { error?: { message?: string } } | null)?.error?.message ?? 'unknown error';
    this.logger.warn(`Visual review rejected (HTTP ${status}): ${message}`);
    if ((status === 400 || status === 402) && /credit|billing|balance|quota/i.test(message))
      return new ApplicationError(
        402,
        'AI_CREDITS_REQUIRED',
        'The AI provider account has no remaining credits. Add credits or switch providers in Settings.',
      );
    if (status === 401 || status === 403)
      return new ApplicationError(
        503,
        'AI_AUTHENTICATION_FAILED',
        'The AI credential was rejected. Verify the provider configuration in Settings.',
      );
    return new ApplicationError(
      502,
      'VISUAL_REVIEW_FAILED',
      'The AI provider could not look at this recording.',
    );
  }
}
