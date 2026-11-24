import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobberConnectionStatus, type JobberMirrorCursor, type JobberRecordKind } from '@prisma/client';
import { z } from 'zod';

import { PrismaService } from '../../common/prisma.service';
import {
  isCutShort,
  MIRROR_KINDS,
  mirrorOneQuery,
  mirrorPageQuery,
  type MirrorKind,
} from '../../integrations/jobber/jobber-mirror.kinds';
import { markUnseenDeleted, saveMirrorPage, type MirrorNode } from '../../integrations/jobber/jobber-mirror.store';
import { JobberClient, type JobberCost } from '../../integrations/jobber/jobber.client';
import { JobberError } from '../../integrations/jobber/jobber.errors';

/**
 * Pages one run reads across every kind, and how long it may take. The first
 * walk of every visit and job is thousands of pages; read at once it would
 * hold the scheduler's tick for hours. So a run stops here, every kind keeps
 * its place, and the next tick carries on.
 */
const MAX_PAGES_PER_RUN = 40;
const RUN_BUDGET_MS = 90_000;

/** A full walk again weekly, so deletions are noticed; daily for a kind Jobber gives no "what changed". */
const WALK_AGAIN_MS = 7 * 24 * 3_600_000;
const WALK_AGAIN_UNFILTERED_MS = 24 * 3_600_000;
/** How often "what changed" is read for a kind that has caught up. */
const CHANGES_EVERY_MS = 60 * 60_000;
/** A pass's next "since" is this long before it began, so an edit during it is read again. */
const PASS_MARGIN_MS = 5 * 60_000;
/** Jobber's `after` is strict: one second of overlap costs a re-save that changes nothing. */
const OVERLAP_MS = 1_000;
/** Visits have no update time, so the ones that still move are re-read by date. */
const VISIT_BACK_DAYS = 30;
const VISIT_AHEAD_DAYS = 120;
const DAY_MS = 24 * 3_600_000;

const THROTTLE_WAIT_MS = 15_000;
const THROTTLE_RETRIES = 2;
const BUCKET_RESERVE = 1_000;
const MAX_PACE_WAIT_SECONDS = 30;

const pageSchema = z.object({
  nodes: z.array(z.object({ id: z.string() }).passthrough()),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});

export interface MirrorKindResult {
  kind: JobberRecordKind;
  mode: 'walk' | 'changes';
  pages: number;
  saved: number;
  readAlone: number;
  caughtUp: boolean;
  deleted: number;
  problem: string | null;
}

export interface MirrorRunResult {
  skipped: 'NOT_CONNECTED' | null;
  pages: number;
  kinds: MirrorKindResult[];
}

type CursorState = Partial<Pick<
  JobberMirrorCursor,
  | 'walkCursor'
  | 'walkStartedAt'
  | 'walkCompletedAt'
  | 'walkSeen'
  | 'changesCursor'
  | 'changesStartedAt'
  | 'changesCompletedAt'
  | 'changesSince'
>>;

class Throttled extends Error {}

/**
 * Copies every Jobber record into `JobberRecord` (2026-11-24), read-only.
 *
 * Each kind is walked once from the start, then read for "what changed" --
 * by update time, or for visits by a window of dates -- and walked again
 * weekly (daily for properties) so a record deleted in Jobber is noticed. A run
 * is bounded and paces itself on the bucket Jobber reports, after the visit
 * sync and the invoice read have had the tick.
 */
@Injectable()
export class JobberMirrorWorker {
  private readonly logger = new Logger(JobberMirrorWorker.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberClient) private readonly client: JobberClient,
  ) {}

  async run(organizationId: string, now: Date = new Date()): Promise<MirrorRunResult> {
    const result: MirrorRunResult = { skipped: null, pages: 0, kinds: [] };
    const connection = await this.prisma.jobberConnection.findUnique({
      where: { organizationId },
      select: { status: true },
    });
    if (connection?.status !== JobberConnectionStatus.CONNECTED) return { ...result, skipped: 'NOT_CONNECTED' };

    const started = Date.now();
    for (const spec of MIRROR_KINDS) {
      if (result.pages >= MAX_PAGES_PER_RUN || Date.now() - started >= RUN_BUDGET_MS) break;
      const cursor: CursorState =
        (await this.prisma.jobberMirrorCursor.findUnique({
          where: { organizationId_kind: { organizationId, kind: spec.kind } },
        })) ?? {};
      const mode = this.modeFor(spec, cursor, now);
      if (!mode) continue;
      const kindResult: MirrorKindResult = {
        kind: spec.kind,
        mode,
        pages: 0,
        saved: 0,
        readAlone: 0,
        caughtUp: false,
        deleted: 0,
        problem: null,
      };
      result.kinds.push(kindResult);
      try {
        await this.read(organizationId, spec, mode, cursor, now, started, result, kindResult);
      } catch (error) {
        if (error instanceof Throttled) {
          // The bucket is empty for everyone: give the tick back. Every cursor
          // is where the last saved page left it.
          kindResult.problem = 'THROTTLED';
          break;
        }
        kindResult.problem = error instanceof JobberError ? error.code : 'UNEXPECTED';
        await this.recordError(organizationId, spec.kind, kindResult.problem, now);
        this.logger.error({
          event: 'jobber_mirror_kind_failed',
          organizationId,
          kind: spec.kind,
          code: kindResult.problem,
          message: error instanceof Error ? error.message : 'unexpected',
        });
      }
    }
    return result;
  }

  /** Whether this kind has anything to read this run, and how. */
  private modeFor(spec: MirrorKind, cursor: CursorState, now: Date): 'walk' | 'changes' | null {
    if (cursor.walkCursor || !cursor.walkCompletedAt) return 'walk';
    const walkAgain = spec.changes ? WALK_AGAIN_MS : WALK_AGAIN_UNFILTERED_MS;
    if (now.getTime() - cursor.walkCompletedAt.getTime() >= walkAgain) return 'walk';
    if (!spec.changes) return null;
    if (cursor.changesCursor) return 'changes';
    if (!cursor.changesCompletedAt || now.getTime() - cursor.changesCompletedAt.getTime() >= CHANGES_EVERY_MS)
      return 'changes';
    return null;
  }

  private async read(
    organizationId: string,
    spec: MirrorKind,
    mode: 'walk' | 'changes',
    cursor: CursorState,
    now: Date,
    started: number,
    run: MirrorRunResult,
    result: MirrorKindResult,
  ) {
    // A walk in progress keeps its start; a new one starts now and counts from nothing.
    const continuing = mode === 'walk' ? Boolean(cursor.walkCursor) : Boolean(cursor.changesCursor);
    const passStartedAt = continuing ? ((mode === 'walk' ? cursor.walkStartedAt : cursor.changesStartedAt) ?? now) : now;
    let after = continuing ? ((mode === 'walk' ? cursor.walkCursor : cursor.changesCursor) ?? null) : null;
    let walkSeen = mode === 'walk' && continuing ? (cursor.walkSeen ?? 0) : 0;
    const variables = this.variablesFor(spec, mode, cursor, passStartedAt);
    const query = mirrorPageQuery(spec, mode);

    while (run.pages < MAX_PAGES_PER_RUN && Date.now() - started < RUN_BUDGET_MS) {
      const { data, cost } = await this.readPage(organizationId, query, { first: spec.pageSize, after, ...variables }, started);
      const page = pageSchema.parse((data as Record<string, unknown>)[spec.connection]);
      const nodes = await this.complete(organizationId, spec, page.nodes as MirrorNode[], result);
      run.pages += 1;
      result.pages += 1;
      result.saved += nodes.length;
      after = page.pageInfo.endCursor;
      const caughtUp = !page.pageInfo.hasNextPage;
      const checked = { lastCheckedAt: now, lastError: null, lastErrorAt: null };

      if (mode === 'walk') {
        walkSeen += nodes.length;
        await saveMirrorPage(this.prisma, organizationId, spec.kind, nodes, now, {
          ...checked,
          walkStartedAt: passStartedAt,
          walkSeen,
          ...(caughtUp
            ? {
                walkCursor: null,
                walkCompletedAt: now,
                changesCursor: null,
                changesStartedAt: null,
                changesSince: new Date(passStartedAt.getTime() - PASS_MARGIN_MS),
              }
            : { walkCursor: after }),
        });
        if (caughtUp) {
          const marked = await markUnseenDeleted(this.prisma, organizationId, spec.kind, passStartedAt, walkSeen);
          result.deleted = marked.deleted;
          if (marked.short) {
            result.problem = 'WALK_SHORT';
            await this.recordError(organizationId, spec.kind, 'WALK_SHORT', now);
          }
        }
      } else {
        await saveMirrorPage(this.prisma, organizationId, spec.kind, nodes, now, {
          ...checked,
          changesStartedAt: passStartedAt,
          ...(caughtUp
            ? {
                changesCursor: null,
                changesCompletedAt: now,
                changesSince: new Date(passStartedAt.getTime() - PASS_MARGIN_MS),
              }
            : { changesCursor: after }),
        });
      }
      if (caughtUp) {
        result.caughtUp = true;
        return;
      }
      if (!(await this.pace(cost, started))) return;
    }
  }

  private variablesFor(spec: MirrorKind, mode: 'walk' | 'changes', cursor: CursorState, passStartedAt: Date) {
    if (mode === 'walk') return {};
    if (spec.changes === 'startAtWindow')
      return {
        from: new Date(passStartedAt.getTime() - VISIT_BACK_DAYS * DAY_MS).toISOString(),
        to: new Date(passStartedAt.getTime() + VISIT_AHEAD_DAYS * DAY_MS).toISOString(),
      };
    const since = cursor.changesSince ?? cursor.walkStartedAt ?? passStartedAt;
    return { since: new Date(since.getTime() - OVERLAP_MS).toISOString() };
  }

  /** Records with more notes or lines than a page carries, read again by themselves. */
  private async complete(organizationId: string, spec: MirrorKind, nodes: MirrorNode[], result: MirrorKindResult) {
    if (!spec.single) return nodes;
    const out: MirrorNode[] = [];
    for (const node of nodes) {
      if (!isCutShort(node)) {
        out.push(node);
        continue;
      }
      result.readAlone += 1;
      const data = await this.client.request<Record<string, MirrorNode | null>>(organizationId, mirrorOneQuery(spec), {
        id: node.id,
      });
      out.push(data[spec.single] ?? node);
    }
    return out;
  }

  private async recordError(organizationId: string, kind: JobberRecordKind, code: string, now: Date) {
    const data = { lastError: code, lastErrorAt: now, lastCheckedAt: now };
    await this.prisma.jobberMirrorCursor.upsert({
      where: { organizationId_kind: { organizationId, kind } },
      create: { organizationId, kind, ...data },
      update: data,
    });
  }

  private async readPage(organizationId: string, query: string, variables: Record<string, unknown>, started: number) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.client.requestDetailed(organizationId, query, variables);
      } catch (error) {
        const throttled = error instanceof JobberError && error.retryable;
        if (!throttled) throw error;
        if (attempt >= THROTTLE_RETRIES || Date.now() - started + THROTTLE_WAIT_MS > RUN_BUDGET_MS) throw new Throttled();
        await this.sleep(THROTTLE_WAIT_MS);
      }
    }
  }

  /** Waits for the bucket to hold this page's cost plus a reserve; false when the run has no time left to wait. */
  private async pace(cost: JobberCost | undefined, started: number) {
    const status = cost?.throttleStatus;
    if (!status || status.restoreRate <= 0) return true;
    const needed = (cost.requestedQueryCost ?? 0) + BUCKET_RESERVE;
    if (status.currentlyAvailable >= needed) return true;
    const seconds = Math.min((needed - status.currentlyAvailable) / status.restoreRate, MAX_PACE_WAIT_SECONDS);
    if (Date.now() - started + seconds * 1_000 > RUN_BUDGET_MS) return false;
    await this.sleep(seconds * 1_000);
    return true;
  }

  protected sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
