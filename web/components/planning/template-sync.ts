import {
  applyGroupOps,
  diffGroupOps,
  sameGroups,
  type GroupTemplateOp,
  type GroupTemplateOpsEvent,
  type LiveGroups,
} from '@texasrenters/shared';

/**
 * Keeping one browser's copy of a live group template in step with the server
 * and everyone else editing it (the office, 2026-10-01).
 *
 * What this person does goes out as operations, one batch at a time and in
 * order; what everyone else does arrives as the server applied it, a revision
 * at a time, and is applied to what this person sees. The server's copy is
 * followed batch by batch (`confirmed`), and whenever nothing of this person's
 * is still on its way, what they see is brought to exactly that copy -- so two
 * people who edited the same group at once see the same thing a moment later.
 *
 * A revision that never arrives -- the live channel dropped for a moment --
 * means the template is read again rather than guessed at, and so does a change
 * the server refused.
 */

export type SyncStatus =
  | { kind: 'saved' }
  | { kind: 'saving' }
  /** A batch could not reach the server; it is being sent again. */
  | { kind: 'offline' }
  /** The server refused a change -- somebody archived the template, say -- and it was read again. */
  | { kind: 'refused'; message: string };

export interface TemplateSyncDeps {
  /** The groups as the server last gave them, stops as building ids, and at which revision. */
  base: LiveGroups<string>;
  revision: number;
  post: (batchId: string, ops: GroupTemplateOp<string>[]) => Promise<{ revision: number }>;
  fetch: () => Promise<{ groups: LiveGroups<string>; revision: number }>;
  /** What this person sees now, as building ids. */
  view: () => LiveGroups<string>;
  /** Operations to make to what this person sees: somebody else's, or those that catch it up. */
  applyToView: (ops: GroupTemplateOp<string>[]) => void;
  /** What of the server's copy this browser can show: a property it does not draw is left out. */
  visible?: (groups: LiveGroups<string>) => LiveGroups<string>;
  onStatus: (status: SyncStatus) => void;
  newId: () => string;
  /** Whether a failed request is the server saying no, rather than the network failing. */
  refused?: (error: unknown) => string | null;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** How long a missing revision is waited for before the template is read again. */
  gapMs?: number;
}

interface Batch {
  batchId: string;
  ops: GroupTemplateOp<string>[];
}

export class TemplateSync {
  private confirmed: LiveGroups<string>;
  private revision: number;
  private queue: GroupTemplateOp<string>[] = [];
  private inflight: Batch | null = null;
  /** Batches known to be saved, by revision, waiting for the ones before them. */
  private arrived = new Map<number, Batch>();
  private gapTimer: unknown = null;
  private resyncing = false;
  private closed = false;

  constructor(private readonly deps: TemplateSyncDeps) {
    this.confirmed = deps.base;
    this.revision = deps.revision;
  }

  /** Whether anything this person did is still on its way. */
  get pending(): boolean {
    return this.inflight !== null || this.queue.length > 0;
  }

  get currentRevision(): number {
    return this.revision;
  }

  /** This person changed something: the operations that make the change. */
  local(ops: readonly GroupTemplateOp<string>[]) {
    if (this.closed || !ops.length) return;
    this.queue.push(...ops);
    void this.flush();
  }

  /** A batch the server saved, as the live channel told it -- somebody else's, or this person's own coming back. */
  received(event: Pick<GroupTemplateOpsEvent, 'revision' | 'batchId' | 'ops'>) {
    if (this.closed || event.revision <= this.revision) return;
    if (!this.arrived.has(event.revision)) this.arrived.set(event.revision, { batchId: event.batchId, ops: event.ops });
    this.advance();
  }

  /** The live channel is back, or said the template is further on than this copy: read it again. */
  resyncFrom(revision?: number) {
    if (revision === undefined || revision > this.revision) void this.resync();
  }

  close() {
    this.closed = true;
    this.clearGap();
  }

  private async flush() {
    if (this.closed || this.resyncing || this.inflight || !this.queue.length) return;
    const batch: Batch = { batchId: this.deps.newId(), ops: this.queue.splice(0) };
    this.inflight = batch;
    this.deps.onStatus({ kind: 'saving' });
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; !this.closed; attempt += 1) {
      try {
        const { revision } = await this.deps.post(batch.batchId, batch.ops);
        // Read again meanwhile: whatever this batch did comes back as it was saved.
        if (this.inflight !== batch) return;
        if (revision > this.revision && !this.arrived.has(revision)) this.arrived.set(revision, batch);
        this.advance();
        return;
      } catch (error) {
        const refusal = this.deps.refused?.(error) ?? null;
        if (refusal !== null) {
          if (this.inflight === batch) this.inflight = null;
          this.deps.onStatus({ kind: 'refused', message: refusal });
          await this.resync();
          return;
        }
        this.deps.onStatus({ kind: 'offline' });
        await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
        if (this.inflight !== batch) return;
      }
    }
  }

  /** Every batch the server saved next, in order, into the server's copy and -- somebody else's -- into the view. */
  private advance() {
    let next = this.arrived.get(this.revision + 1);
    while (next) {
      this.arrived.delete(this.revision + 1);
      this.revision += 1;
      this.confirmed = applyGroupOps(this.confirmed, next.ops);
      if (this.inflight && next.batchId === this.inflight.batchId) this.inflight = null;
      else this.deps.applyToView(next.ops);
      next = this.arrived.get(this.revision + 1);
    }
    this.clearGap();
    if (this.arrived.size) {
      const setTimer = this.deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
      this.gapTimer = setTimer(() => void this.resync(), this.deps.gapMs ?? 3_000);
    }
    if (this.inflight) return;
    if (this.queue.length) {
      void this.flush();
      return;
    }
    this.settle();
    this.deps.onStatus({ kind: 'saved' });
  }

  /** With nothing on its way, what this person sees is exactly the server's copy. */
  private settle() {
    const target = this.visibleOf(this.confirmed);
    const view = this.deps.view();
    if (!sameGroups(view, target)) this.deps.applyToView(diffGroupOps(view, target));
  }

  private visibleOf(groups: LiveGroups<string>) {
    return this.deps.visible ? this.deps.visible(groups) : groups;
  }

  /** The template read again, and what is still queued made on top of it. */
  private async resync() {
    if (this.closed || this.resyncing) return;
    this.resyncing = true;
    this.clearGap();
    try {
      const fresh = await this.deps.fetch();
      this.confirmed = fresh.groups;
      this.revision = fresh.revision;
      this.arrived.clear();
      // Anything sent and not yet seen is in the copy just read, or was refused.
      this.inflight = null;
      const target = this.visibleOf(applyGroupOps(this.confirmed, this.queue));
      const view = this.deps.view();
      if (!sameGroups(view, target)) this.deps.applyToView(diffGroupOps(view, target));
    } catch {
      this.deps.onStatus({ kind: 'offline' });
      const setTimer = this.deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
      this.gapTimer = setTimer(() => void this.resync(), 5_000);
      return;
    } finally {
      this.resyncing = false;
    }
    if (this.queue.length) void this.flush();
    else this.deps.onStatus({ kind: 'saved' });
  }

  private clearGap() {
    if (this.gapTimer === null) return;
    (this.deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(this.gapTimer);
    this.gapTimer = null;
  }
}
