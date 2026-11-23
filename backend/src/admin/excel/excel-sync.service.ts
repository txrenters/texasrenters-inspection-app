import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  MAX_LOG_DAYS,
  firstName,
  monthEnd,
  revenueCell,
  weekOf,
  type ExcelFormulaRepair,
  type ExcelPull,
  type ExcelSyncRun,
  type ExcelSyncView,
  type RevenueLiveScope,
  type SaveExcelSyncInput,
} from '@texasrenters/shared';
import type { ExcelSyncSheet, Prisma } from '@prisma/client';

import { auditActor, type AuthenticatedUser } from '../../common/auth';
import { businessDate } from '../../common/business-day';
import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ActualVsBudgetGateway } from '../actual-vs-budget.gateway';
import { ActualVsBudgetService } from '../actual-vs-budget.service';
import { cellText, columnLetter, dailyTab, logTab, monthTab, projectionTab, trackerTab, weekTab, type ExcelCell, type ExcelEditableField, type ExcelTab } from '../excel-layout';
import { formatOf, isFormula, repairFormats } from './excel-formats';
import { ExcelGraphClient } from './excel-graph.client';
import { dayFrom } from '../workbook-import';
import { LOG_WIDTH, planLogTab, sameCell, writtenOf, type ConsoleLogRow, type LogTabPlan } from './excel-log-rows';
import { readTab, type ExcelEdit } from './excel-read';
import { MicrosoftAuthService, MicrosoftError } from './microsoft-auth.service';
import { microsoftConfigured } from './microsoft.config';

/**
 * Actual vs Budget kept in step with the office's own workbook (2026-11-17;
 * the office: "everything should sync on this spreadsheet also ... Both ways").
 *
 * Every save marks the office's workbook as waiting, and the next run -- the
 * scheduler's, each minute, or "Sync now" -- writes the tabs those saves show
 * in: next day's projection for today and tomorrow, the daily report and the
 * revenue tracker for yesterday and today, and the weeks and months they fall
 * in, each named and laid out as the office's own tabs. It remembers what it
 * last wrote into each tab and sends only the rows that changed, inside a
 * per-run call budget. A tab dated before the sync's first day is the office's
 * and is never written. Each technician's own log tab ("Amy", "Kevin") gets
 * the console's log from that day on (2026-11-18): the tab is taken over from
 * its first row of that day -- the office's rows from there are brought into
 * the console, what the console already holds standing, and the console's
 * rows take their place -- so each visit is on the tab once. From then on its
 * rows are found by what they are, never by where they sit (`planLogTab`):
 * the office adds, moves and sorts rows, and keeps its own Total rows.
 *
 * And back (2026-11-18): each minute one call asks Microsoft for the
 * workbook's version. When it is not the one the console's last write left,
 * someone has edited the workbook: before anything is written, the console's
 * tabs are read, and what the office typed in a cell it types in on the page
 * comes into the console (see `readTab`), live on everyone's page; anything
 * else changed in those tabs is put back. A run that writes always reads
 * first when the workbook changed, so a save in the console never writes over
 * a cell the office just typed in Excel.
 */

const DAY_MS = 86_400_000;
/** With no save to write, the tabs are written again this often anyway: a new day's tabs appear by themselves. */
const QUIET_REWRITE_MS = 15 * 60_000;
const CLAIM_MS = 3 * 60_000;
/**
 * Runs come no closer than this when nothing of the console's waits to be
 * written -- only the office's edits to read, or a run that left tabs for the
 * next (2026-11-18: a run that never finished re-ran every minute, reading and
 * writing the workbook while the office typed in it, and Excel told the office
 * it "couldn't merge your changes with changes from someone else").
 */
const MIN_RUN_GAP_MS = 2 * 60_000;
/** A run that failed is not tried again sooner than this. */
const FAILURE_BACKOFF_MS = 2 * 60_000;
/** Log tabs taken over in one run, at most: each costs a few calls more than a write, and a run has a budget. */
const TAKEOVERS_PER_RUN = 2;
/** Log tabs read in one run, at most (two calls each, and the writes): the rest are read by the next run. */
const LOG_TABS_PER_RUN = 10;
/** Read past a tab's last row, so a row the office added under it is seen. */
const EXTRA_ROWS_READ = 3;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
/** A range as read, without the empty rows under its last filled one. */
const trimEmptyRows = (rows: ExcelCell[][]) => {
  let last = rows.length;
  while (last > 0 && rows[last - 1]!.every((cell) => !cellText(cell).trim())) last -= 1;
  return rows.slice(0, last);
};
/** Row numbers as blocks of rows side by side, first and last of each: [3, 4, 5, 9] -> [3, 5], [9, 9]. */
const blocks = (rows: readonly number[]) => {
  const runs: [number, number][] = [];
  for (const row of [...new Set(rows)].sort((left, right) => left - right)) {
    const last = runs.at(-1);
    if (last && last[1] === row - 1) last[1] = row;
    else runs.push([row, row]);
  }
  return runs;
};

@Injectable()
export class ExcelSyncService {
  private readonly logger = new Logger(ExcelSyncService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MicrosoftAuthService) private readonly auth: MicrosoftAuthService,
    @Inject(ActualVsBudgetService) private readonly revenue: ActualVsBudgetService,
    @Optional() @Inject(ActualVsBudgetGateway) private readonly live?: ActualVsBudgetGateway,
  ) {}

  async view(user: AuthenticatedUser): Promise<ExcelSyncView> {
    const config = this.auth.config();
    const [connection, sync] = await Promise.all([
      this.prisma.microsoftConnection.findUnique({ where: { organizationId: user.organizationId } }),
      this.prisma.excelSync.findUnique({ where: { organizationId: user.organizationId } }),
    ]);
    return {
      configured: microsoftConfigured(config),
      redirectUri: config.redirectUri ?? null,
      connection:
        connection && connection.status !== 'DISCONNECTED'
          ? {
              status: connection.status as 'CONNECTED' | 'REAUTHORIZATION_REQUIRED',
              accountEmail: connection.accountEmail,
              accountName: connection.accountName,
              connectedAt: connection.connectedAt?.toISOString() ?? null,
              problem: connection.lastRefreshError,
            }
          : null,
      workbook: sync
        ? {
            shareUrl: sync.shareUrl,
            fileName: sync.fileName,
            webUrl: sync.webUrl,
            enabled: sync.enabled,
            startDate: dayOf(sync.startDate),
            lastPushedAt: sync.lastPushedAt?.toISOString() ?? null,
            lastPull: (sync.lastPull as ExcelPull | null) ?? null,
            waiting: Boolean(sync.dirtyAt && (!sync.lastPushedAt || sync.dirtyAt > sync.lastPushedAt)),
            problem: sync.lastError,
          }
        : null,
    };
  }

  /** Where to send the person to sign in to Microsoft. */
  connectUrl(user: AuthenticatedUser) {
    return { authorizationUrl: this.auth.authorizationUrl({ organizationId: user.organizationId, userId: auditActor(user).actorUserId }) };
  }

  /** Microsoft sent the person back: keep the account's tokens, and say whose account it is. */
  async completeConnection(code: string | undefined, rawState: string | undefined) {
    const state = this.auth.readState(rawState);
    if (!code) throw new MicrosoftError('Microsoft sent no sign-in code. Start again.', 'MICROSOFT_NO_CODE', 400);
    const tokens = await this.auth.exchange(code, state.codeVerifier);
    await this.auth.store(state.organizationId, tokens, { connectedByUserId: state.userId, connectedAt: new Date() });
    const account = await new ExcelGraphClient(this.auth, state.organizationId).me();
    await this.prisma.microsoftConnection.update({
      where: { organizationId: state.organizationId },
      data: { accountEmail: account.email, accountName: account.name },
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId: state.organizationId,
        actorUserId: state.userId,
        action: 'MICROSOFT_CONNECTED',
        entityType: 'MicrosoftConnection',
        entityId: state.organizationId,
        metadata: { account: account.email, purpose: 'Actual vs Budget workbook' },
      },
    });
    return account;
  }

  async disconnect(user: AuthenticatedUser) {
    await this.auth.disconnect(user.organizationId);
    await this.prisma.excelSync.updateMany({ where: { organizationId: user.organizationId }, data: { enabled: false } });
    await this.audit(user, 'MICROSOFT_DISCONNECTED', {});
    return this.view(user);
  }

  /**
   * Link the workbook from its sharing link, choose the first day the console
   * writes, and turn the sync on or off. A new link is opened as the connected
   * account before it is kept: one that account cannot open is refused here,
   * not at the first write.
   */
  async save(user: AuthenticatedUser, input: SaveExcelSyncInput): Promise<ExcelSyncView> {
    const organizationId = user.organizationId;
    if (input.startDate !== undefined && !DAY.test(input.startDate)) throw new ApplicationError(422, 'BAD_DATES', 'Give the first day as YYYY-MM-DD.');
    const current = await this.prisma.excelSync.findUnique({ where: { organizationId } });
    let file: { shareUrl: string; driveId: string; itemId: string; fileName: string; webUrl: string | null } | null = null;
    if (input.shareUrl !== undefined && input.shareUrl.trim() !== current?.shareUrl) {
      const shareUrl = input.shareUrl.trim();
      if (!/^https:\/\/[\w.-]+\.sharepoint\.com\//i.test(shareUrl))
        throw new ApplicationError(422, 'EXCEL_LINK_NOT_SHAREPOINT', 'Paste the workbook’s SharePoint or OneDrive link (https://….sharepoint.com/…).');
      const client = new ExcelGraphClient(this.auth, organizationId);
      const shared = await client.resolveShare(shareUrl);
      // Can this account open it as a workbook at all?
      await new ExcelGraphClient(this.auth, organizationId, shared).worksheetNames();
      file = { shareUrl, driveId: shared.driveId, itemId: shared.itemId, fileName: shared.name, webUrl: shared.webUrl };
    }
    if (!current && !file) throw new ApplicationError(422, 'EXCEL_LINK_NEEDED', 'Paste the workbook’s link first.');
    const changes = {
      ...(file ?? {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.startDate !== undefined ? { startDate: new Date(`${input.startDate}T00:00:00.000Z`) } : {}),
      // Whatever changed, the next run writes.
      dirtyAt: new Date(),
      lastError: null,
      // A different workbook's version says nothing about this one.
      ...(file ? { fileTag: null } : {}),
    };
    if (current) {
      // A different workbook: what was written into the last one says nothing about this one.
      if (file && file.itemId !== current.itemId) await this.prisma.excelSyncSheet.deleteMany({ where: { organizationId } });
      await this.prisma.excelSync.update({ where: { organizationId }, data: changes });
    } else {
      await this.prisma.excelSync.create({
        data: {
          organizationId,
          ...file!,
          enabled: input.enabled ?? false,
          // From tomorrow by default: the office's tabs up to today stay theirs.
          startDate: new Date(`${input.startDate ?? shiftDay(businessDate(), 1)}T00:00:00.000Z`),
          dirtyAt: new Date(),
        },
      });
    }
    await this.audit(user, 'EXCEL_SYNC_CHANGED', { file: file?.fileName, enabled: input.enabled, startDate: input.startDate });
    return this.view(user);
  }

  /** "Sync now": write at once, whatever the schedule. */
  async syncNow(user: AuthenticatedUser): Promise<ExcelSyncRun> {
    const claimed = await this.claim(user.organizationId);
    if (!claimed) throw new ApplicationError(409, 'EXCEL_SYNC_RUNNING', 'The workbook is being written now. It is done within a minute.');
    return this.runClaimed(user.organizationId);
  }

  /**
   * The scheduler's run for one office, each minute: a write when a save
   * waits or the tabs have not been written for a while; otherwise one call
   * for the workbook's version, and a run only when the office has edited it.
   */
  async runIfDue(organizationId: string, now = new Date()): Promise<ExcelSyncRun | null> {
    const sync = await this.prisma.excelSync.findUnique({
      where: { organizationId },
      select: { enabled: true, dirtyAt: true, lastPushedAt: true, fileTag: true, driveId: true, itemId: true },
    });
    if (!sync?.enabled) return null;
    const waiting = sync.dirtyAt && (!sync.lastPushedAt || sync.dirtyAt > sync.lastPushedAt);
    const stale = !sync.lastPushedAt || now.getTime() - sync.lastPushedAt.getTime() > QUIET_REWRITE_MS;
    // Only Excel's edits to read, or tabs a run left: not again so soon after the last run.
    if (!waiting && sync.lastPushedAt && now.getTime() - sync.lastPushedAt.getTime() < MIN_RUN_GAP_MS) return null;
    if (!(await this.claim(organizationId))) return null;
    if (!waiting && !stale) {
      // Nothing of the console's to write: has the office edited the workbook?
      let edited = false;
      try {
        const connection = await this.prisma.microsoftConnection.findUnique({ where: { organizationId }, select: { status: true } });
        if (connection?.status === 'CONNECTED') {
          const tag = await new ExcelGraphClient(this.auth, organizationId, { driveId: sync.driveId, itemId: sync.itemId }).fileTag();
          edited = Boolean(tag && tag !== sync.fileTag);
        }
      } catch (error) {
        // The next minute asks again; a write's own failure is what the office's row reports.
        this.logger.warn({ event: 'excel_sync_check_failed', organizationId, error: error instanceof Error ? error.message : String(error) });
      }
      if (!edited) {
        await this.prisma.excelSync.update({ where: { organizationId }, data: { claimedUntil: null } });
        return null;
      }
    }
    return this.runClaimed(organizationId);
  }

  private async claim(organizationId: string) {
    const now = new Date();
    const claimed = await this.prisma.excelSync.updateMany({
      where: { organizationId, OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] },
      data: { claimedUntil: new Date(now.getTime() + CLAIM_MS) },
    });
    return claimed.count === 1;
  }

  private async runClaimed(organizationId: string): Promise<ExcelSyncRun> {
    const startedAt = new Date();
    try {
      const run = await this.write(organizationId);
      await this.prisma.excelSync.update({ where: { organizationId }, data: { lastPushedAt: startedAt, lastError: null, claimedUntil: null } });
      return run;
    } catch (error) {
      const message = error instanceof ApplicationError ? error.message : 'The workbook could not be written. The next run tries again.';
      if (!(error instanceof ApplicationError)) this.logger.error({ event: 'excel_sync_failed', organizationId, error: String(error) });
      // Not again at once: a failure that repeats would otherwise be another call on the workbook every minute.
      await this.prisma.excelSync.update({ where: { organizationId }, data: { lastError: message.slice(0, 500), claimedUntil: new Date(Date.now() + FAILURE_BACKOFF_MS) } });
      throw error;
    }
  }

  /**
   * The tabs that should be in the workbook now, as the console shows them.
   * With the workbook's tab names, each technician whose first name is a tab
   * of it -- "Amy", "Kevin", as the office named them -- gets their log there,
   * from the sync's first day to tomorrow.
   */
  async tabsFor(
    organizationId: string,
    today = businessDate(),
    sheetNames?: ReadonlySet<string>,
    /** A taken-over log tab keeps the day it was taken over from, when the first day moved later since. */
    logFrom: ReadonlyMap<string, string> = new Map(),
  ): Promise<ExcelTab[]> {
    const sync = await this.prisma.excelSync.findUnique({ where: { organizationId }, select: { startDate: true } });
    if (!sync) return [];
    const start = dayOf(sync.startDate);
    const reader = { id: 'excel-sync', organizationId, displayName: 'Excel sync', permissions: ['invoices:read'] } as unknown as AuthenticatedUser;
    const yesterday = shiftDay(today, -1);
    const tomorrow = shiftDay(today, 1);
    const days = new Map<string, Awaited<ReturnType<ActualVsBudgetService['day']>>>();
    const dayFor = async (date: string) => {
      if (!days.has(date)) days.set(date, await this.revenue.day(reader, date));
      return days.get(date)!;
    };
    const tabs: ExcelTab[] = [];
    for (const date of [today, tomorrow]) if (date >= start) tabs.push(projectionTab(await dayFor(date)));
    for (const date of [yesterday, today])
      if (date >= start) {
        const day = await dayFor(date);
        tabs.push(dailyTab(day), trackerTab(day));
      }
    const months = [...new Set([yesterday.slice(0, 7), today.slice(0, 7)])];
    const weeks = new Map([weekOf(yesterday), weekOf(today)].map((week) => [week.from, week]));
    for (const month of months) {
      // A month that ended before the first day is the office's own. One the sync started part-way through is still the month's report.
      if (monthEnd(month) < start) continue;
      const report = await this.revenue.month(reader, month);
      for (const week of report.weeks) if (weeks.has(week.from) && week.to >= start) tabs.push(weekTab(week));
      tabs.push(monthTab(report));
    }
    if (sheetNames && tomorrow >= start) {
      const { technicians } = await this.revenue.technicians(reader);
      const firstNames = new Map<string, number>();
      for (const technician of technicians) firstNames.set(firstName(technician.name).toLowerCase(), (firstNames.get(firstName(technician.name).toLowerCase()) ?? 0) + 1);
      for (const technician of technicians) {
        const name = firstName(technician.name);
        // Two technicians of one first name: the tab cannot say whose it is.
        if (!sheetNames.has(name) || firstNames.get(name.toLowerCase())! > 1) continue;
        const days = [];
        const first = [logFrom.get(name) ?? start, start].sort()[0]!;
        for (let from = first; from <= tomorrow; from = shiftDay(from, MAX_LOG_DAYS)) {
          const to = [shiftDay(from, MAX_LOG_DAYS - 1), tomorrow].sort()[0]!;
          days.push(...(await this.revenue.log(reader, { technicianId: technician.id, from, to })).days);
        }
        tabs.push(logTab(name, technician.id, days, tomorrow));
      }
    }
    return tabs;
  }

  /**
   * Read the office's edits when the workbook changed since the last write,
   * then write the tabs: a missing one is added; an existing one gets only the
   * rows that differ from what it holds.
   */
  private async write(organizationId: string): Promise<ExcelSyncRun> {
    const [sync, connection] = await Promise.all([
      this.prisma.excelSync.findUnique({ where: { organizationId } }),
      this.prisma.microsoftConnection.findUnique({ where: { organizationId }, select: { status: true, accountEmail: true } }),
    ]);
    if (!sync) throw new ApplicationError(409, 'EXCEL_NOT_LINKED', 'No workbook is linked.');
    if (connection?.status !== 'CONNECTED') throw new ApplicationError(409, 'MICROSOFT_NOT_CONNECTED', 'Connect the Microsoft account again to write the workbook.');
    const client = new ExcelGraphClient(this.auth, organizationId, { driveId: sync.driveId, itemId: sync.itemId });
    const run: ExcelSyncRun = { tabs: [], calls: 0, pulled: null };
    const edited = (await client.fileTag()) !== sync.fileTag;
    // Log tabs left for the next run to read: it must read them as edited, whatever the workbook's version says then.
    let deferred = false;
    await client.openSession();
    try {
      const existing = new Set(await client.worksheetNames());
      const snapshots = new Map((await this.prisma.excelSyncSheet.findMany({ where: { organizationId } })).map((sheet) => [sheet.name, sheet]));
      // The Text format the console once gave its cells, put right first -- half a run's calls at most; the next run
      // carries on with the rest.
      const repair = await this.repairPending(client, snapshots, existing, Math.floor(this.auth.config().callsPerRun / 2));
      if (repair.pending) deferred = true;
      if (repair.cells || repair.formulas) await this.recordRepair(organizationId, null, repair);
      const start = dayOf(sync.startDate);
      // Each taken-over log tab, from the day it was taken over, always: it is taken over once and never again, so
      // a first day moved earlier never clears a tab's rows a second time (2026-11-17).
      const logFrom = () =>
        new Map([...snapshots.values()].flatMap((sheet) => (sheet.adoptedFrom ? [[sheet.name, dayOf(sheet.adoptedFrom)] as const] : [])));
      let tabs = await this.tabsFor(organizationId, undefined, existing, logFrom());
      const takenOver = (tab: ExcelTab) => Boolean(snapshots.get(tab.name)?.adoptedFrom);
      // What each tab holds now, where it was read: the write sends whatever differs from it.
      const held = new Map<string, ExcelCell[][]>();
      // The cells the office changed or works out with a formula, where a tab was read: the office's, never written over.
      const officeCells = new Map<string, [number, number][]>();
      // A log tab's rows start where they did: where it was taken over (or, before, under the office's rows). One not
      // taken over yet is placed by its takeover.
      const place = async (tab: ExcelTab) => {
        if (tab.below) tab.below.origin = snapshots.get(tab.name)?.origin ?? undefined;
      };
      for (const tab of tabs) await place(tab);

      if (edited) {
        const pull: ExcelPull = { at: new Date().toISOString(), taken: 0, putBack: 0, conflicts: 0, kept: 0 };
        const edits: (ExcelEdit & { tab: string })[] = [];
        for (const tab of tabs) {
          const written = snapshots.get(tab.name);
          // A log tab is read row by row, by what each row is (`syncLogs`).
          if (!written || !existing.has(tab.name) || tab.below) continue;
          const rows = written.rows as ExcelCell[][];
          const width = Math.max(...rows.map((row) => row.length), ...tab.rows.map((row) => row.length), 1);
          const top = 1;
          const cells = await client.readCells(tab.name, `A${top}:${columnLetter(width - 1)}${top + rows.length - 1 + EXTRA_ROWS_READ}`);
          // What each cell holds, as the console's own cells are: a number as a number, so a day or a figure Excel
          // holds is never taken for a change because of how Excel spells it (2026-11-18: every figure of these tabs
          // was written again on every run that read them).
          held.set(
            tab.name,
            trimEmptyRows(cells.text.map((row, r) => row.map((text, c): ExcelCell => {
              const value = cells.values[r]?.[c];
              return typeof value === 'number' ? { value, format: '' } : text;
            }))),
          );
          // A tab written before the console kept whose each row is (v2.5.245 and earlier) takes the rows of the
          // tab as it is now, when there are as many; their names are checked against Excel's all the same.
          // Otherwise anything changed in it is the office's, and left as it is.
          const sameShape = rows.length === tab.rows.length;
          const read = readTab(
            {
              rows,
              keys: (written.keys as (string | null)[] | null) ?? (sameShape ? tab.keys : rows.map(() => null)),
              editable: (written.editable as Record<number, ExcelEditableField> | null) ?? (sameShape ? tab.editable : {}),
            },
            tab,
            cells,
          );
          // The office's cells stay the office's: those found before, and those found now.
          const before = new Set(((written.formulaCells as [number, number][] | null) ?? []).map((cell) => cell.join(',')));
          const found = read.kept.filter((cell) => !before.has(cell.join(',')));
          officeCells.set(tab.name, [...((written.formulaCells as [number, number][] | null) ?? []), ...found]);
          pull.kept! += found.length;
          pull.conflicts += read.conflicts;
          edits.push(...read.edits.map((edit) => ({ ...edit, tab: tab.name })));
        }
        pull.taken = await this.takeEdits(organizationId, connection.accountEmail, edits);
        run.pulled = pull;
        await this.prisma.excelSync.update({
          where: { organizationId },
          data: { lastPulledAt: new Date(pull.at), lastPull: pull as unknown as Prisma.InputJsonValue },
        });
        // What came in is the console's now: the tabs are worked out again with it.
        if (pull.taken) {
          tabs = await this.tabsFor(organizationId, undefined, existing, logFrom());
          for (const tab of tabs) await place(tab);
        }
      }

      // A log tab not taken over yet (or whose first day moved earlier) is taken over now, a few a run; the rest wait,
      // unwritten, for the next run, which the save left waiting.
      let takeovers = 0;
      let waiting = false;
      for (const tab of tabs) {
        // A technician with nothing on the console's log (one who has left) has a tab the console has nothing to do in.
        if (!tab.below || takenOver(tab) || !tab.keys.some(Boolean)) continue;
        if (takeovers >= TAKEOVERS_PER_RUN) {
          waiting = true;
          continue;
        }
        takeovers += 1;
        snapshots.set(tab.name, await this.takeOver(client, organizationId, tab.name, start, snapshots.get(tab.name)?.origin ?? null));
        held.delete(tab.name);
      }
      if (takeovers) {
        tabs = await this.tabsFor(organizationId, undefined, existing, logFrom());
        for (const tab of tabs) await place(tab);
      }
      if (waiting) {
        // The others are taken over by a later run -- not at once: this run says it left work (`deferred`).
        tabs = tabs.filter((tab) => !tab.below || takenOver(tab));
        deferred = true;
      }

      // The technicians' log tabs: the office's edits and rows in, the console's changes out, each row found by what it is.
      const logs = await this.syncLogs(client, organizationId, connection.accountEmail, tabs.filter(takenOver), snapshots, edited, async () => {
        tabs = await this.tabsFor(organizationId, undefined, existing, logFrom());
        for (const tab of tabs) await place(tab);
        if (waiting) tabs = tabs.filter((tab) => !tab.below || takenOver(tab));
        return tabs.filter(takenOver);
      });
      run.tabs.push(...logs.tabs);
      if (logs.pull) {
        const pull = run.pulled ?? { at: new Date().toISOString(), taken: 0, putBack: 0, conflicts: 0, kept: 0 };
        run.pulled = { ...pull, taken: pull.taken + logs.pull.taken, conflicts: pull.conflicts + logs.pull.conflicts };
        await this.prisma.excelSync.update({
          where: { organizationId },
          data: { lastPulledAt: new Date(run.pulled.at), lastPull: run.pulled as unknown as Prisma.InputJsonValue },
        });
      }
      // Work left by the formats' repair, the takeovers or the log tabs: any of them.
      deferred = deferred || logs.deferred;

      for (const tab of tabs) {
        if (tab.below) continue;
        const before = snapshots.get(tab.name);
        // A tab of that name the console never wrote is the office's own (2026-11-18, "the spreadsheet will be the
        // source of truth"): never written.
        if (existing.has(tab.name) && !before) {
          run.tabs.push({ name: tab.name, created: false, rowsWritten: 0 });
          continue;
        }
        const holds = held.get(tab.name) ?? (before?.rows as ExcelCell[][] | undefined);
        const office = officeCells.get(tab.name) ?? (before?.formulaCells as [number, number][] | null) ?? [];
        const written = await this.writeTab(
          client,
          tab,
          existing.has(tab.name),
          holds ? { rows: holds, bold: (before?.bold as number[] | undefined) ?? [] } : null,
          office,
        );
        if (written.rowsWritten || written.created || !before?.keys || officeCells.has(tab.name)) {
          const snapshot = { ...this.snapshotOf(tab), formulaCells: office as unknown as Prisma.InputJsonValue };
          await this.prisma.excelSyncSheet.upsert({
            where: { organizationId_name: { organizationId, name: tab.name } },
            // A tab the console writes from now is written in the right formats: nothing of it to put right.
            create: { organizationId, name: tab.name, ...snapshot, formatsCheckedAt: new Date() },
            update: snapshot,
          });
        }
        run.tabs.push({ name: tab.name, ...written });
      }
    } finally {
      await client.closeSession();
    }
    // The version the console's own write left: a different one next time is the office's edit.
    // Work left for the next run: it reads as if the office had edited, whatever the version says -- the next run,
    // not this minute's next (`MIN_RUN_GAP_MS`): nothing of the console's waits on it.
    const fileTag = deferred ? null : await client.fileTag().catch(() => null);
    await this.prisma.excelSync.update({ where: { organizationId }, data: { fileTag } });
    run.calls = client.callsMade;
    return run;
  }

  /**
   * Take a technician's log tab over from the sync's first day, every cell of
   * it left as it is (2026-11-18: "the spreadsheet will be the source of
   * truth"). Only where its rows of that day begin is found: its first row of
   * that day or later, or under its last row. From there each row is matched
   * to the console's by its day and Job# (`planLogTab`): the office's cells
   * stand and come into the console, its own rows come in, and the console
   * only fills what is empty and adds what the tab lacks, at its foot.
   */
  private async takeOver(client: ExcelGraphClient, organizationId: string, name: string, start: string, oldOrigin: number | null) {
    const last = await client.lastUsedRow(name);
    const dates = last ? await client.readCells(name, `A1:A${last}`) : { text: [], values: [] };
    const dayAt = (row: number) => {
      const value = dates.values[row]?.[0];
      return typeof value === 'number' ? dayFrom(String(Math.floor(value))) : dayFrom(dates.text[row]?.[0]);
    };
    let first = -1;
    for (let row = 0; row < last; row++) {
      const day = dayAt(row);
      if (day && day >= start) {
        first = row;
        break;
      }
    }
    // Nothing of that day yet: where the console's rows began before, or one row under the tab's last.
    if (first < 0) first = oldOrigin ?? last + 1;
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId: null,
        action: 'REVENUE_EXCEL_LOG_TAKEN_OVER',
        entityType: 'ExcelSync',
        entityId: organizationId,
        metadata: { tab: name, from: start, row: first + 1, cleared: false },
      },
    });
    const taken = { origin: first, adoptedFrom: new Date(`${start}T00:00:00.000Z`), rows: [], bold: [], keys: [], editable: {} };
    return this.prisma.excelSyncSheet.upsert({
      where: { organizationId_name: { organizationId, name } },
      create: { organizationId, name, ...taken, formatsCheckedAt: new Date() },
      update: taken,
    });
  }

  /**
   * Each technician's log tab, row by row (see `planLogTab`): read when the
   * office edited the workbook or the console's rows changed since the last
   * write; the office's edits and added rows taken into the console; then the
   * console's own changes written, each into its row wherever the row is now.
   * `again` works the tabs out again once something came in.
   */
  private async syncLogs(
    client: ExcelGraphClient,
    organizationId: string,
    account: string | null,
    tabs: ExcelTab[],
    snapshots: Map<string, { name: string; origin: number | null; rows: unknown; keys: unknown; adoptedFrom: Date | null; updatedAt?: Date }>,
    edited: boolean,
    again: () => Promise<ExcelTab[]>,
  ): Promise<{ tabs: ExcelSyncRun['tabs']; pull: { taken: number; conflicts: number } | null; deferred: boolean }> {
    const rowsOf = (tab: ExcelTab): ConsoleLogRow[] =>
      tab.rows.flatMap((cells, index) => (tab.keys[index] ? [{ key: tab.keys[index]!, cells: Array.from({ length: LOG_WIDTH }, (_, column) => cells[column] ?? '') }] : []));
    const reads = new Map<
      string,
      { tab: ExcelTab; last: number; origin: number; excel: { text: string[][]; values: (string | number | boolean | null)[][]; formulas?: unknown[][] } }
    >();
    const plans = new Map<string, LogTabPlan>();
    const planOf = (name: string, tab: ExcelTab) => {
      const read = reads.get(name)!;
      const snapshot = snapshots.get(name)!;
      return planLogTab({
        consoleRows: rowsOf(tab),
        written: writtenOf(snapshot),
        excel: read.excel,
        editable: tab.editable,
        from: dayOf(snapshot.adoptedFrom!),
        to: tab.below!.to!,
      });
    };
    let deferred = false;
    // The tabs read longest ago first: with more to read than a run reads, every tab has its turn.
    const turn = (tab: ExcelTab) => snapshots.get(tab.name)?.updatedAt?.getTime() ?? 0;
    for (const tab of [...tabs].sort((left, right) => turn(left) - turn(right))) {
      const snapshot = snapshots.get(tab.name)!;
      const written = writtenOf(snapshot);
      const rows = rowsOf(tab);
      // Nothing of the console's in it, and nothing it ever wrote there: a tab of someone who has left.
      if (!rows.length && !Object.keys(written).length) continue;
      // Nothing of the console's changed in it, and nobody edited the workbook: nothing to read or write.
      if (!edited && rows.every((row) => written[row.key]?.every((cell, column) => sameCell(cell, row.cells[column])))) continue;
      if (reads.size >= LOG_TABS_PER_RUN) {
        deferred = true;
        continue;
      }
      const origin = snapshot.origin ?? 0;
      const last = await client.lastUsedRow(tab.name);
      const excel = last > origin ? await client.readCells(tab.name, `A${origin + 1}:${columnLetter(LOG_WIDTH - 1)}${last}`) : { text: [], values: [] };
      reads.set(tab.name, { tab, last, origin, excel });
      plans.set(tab.name, planOf(tab.name, tab));
    }
    if (!reads.size) return { tabs: [], pull: null, deferred };

    const edits = [...plans].flatMap(([name, plan]) => plan.edits.map((edit) => ({ ...edit, tab: name })));
    const conflicts = [...plans.values()].reduce((total, plan) => total + plan.conflicts, 0);
    const taken = await this.takeEdits(organizationId, account, edits);
    const added = await this.addOfficeRows(
      organizationId,
      account,
      [...plans].flatMap(([name, plan]) => plan.added.map((row) => ({ ...row, tab: name, technicianId: reads.get(name)!.tab.below!.technicianId! }))),
    );
    if (taken || added) {
      // What came in is the console's now: its rows are matched to the tab again, the office's cells standing.
      const fresh = new Map((await again()).map((tab) => [tab.name, tab]));
      for (const name of reads.keys()) {
        const tab = fresh.get(name);
        if (!tab) continue;
        reads.get(name)!.tab = tab;
        plans.set(name, planOf(name, tab));
      }
    }

    const results: ExcelSyncRun['tabs'] = [];
    for (const [name, { tab, last, origin }] of reads) {
      const plan = plans.get(name)!;
      const row = (index: number) => origin + index + 1;
      for (const write of plan.writes)
        await this.putCells(client, name, `${columnLetter(write.column)}${row(write.row)}:${columnLetter(write.column + write.cells.length - 1)}${row(write.row)}`, [write.cells]);
      // Rows side by side emptied in one call, not one call a row (2026-11-23: ~2,000 copied rows to empty at the
      // foot of the tabs, against a run's 80 calls).
      for (const [first, final] of blocks(plan.clears))
        await client.clearRange(name, `A${row(first)}:${columnLetter(LOG_WIDTH - 1)}${row(final)}`);
      if (plan.appends.length) {
        // At the foot of the tab, under whatever the office has there -- and under any formula of the office's that
        // shows nothing (a "" result is not a value to Excel's last row): never written over.
        let foot = Math.max(last, origin) + 1;
        for (let look = 0; look < 3; look++) {
          const range = `A${foot}:${columnLetter(LOG_WIDTH - 1)}${foot + plan.appends.length - 1}`;
          const there = await client.readCells(name, range);
          const taken = there.formulas.map((cells, row) => (cells.some((cell, column) => cell !== '' && cell !== null && (isFormula(cell, there.values[row]?.[column] ?? null) || String(cell).trim())) ? row : -1));
          const lastTaken = Math.max(-1, ...taken);
          if (lastTaken < 0) break;
          foot += lastTaken + 1;
        }
        await this.putCells(client, name, `A${foot}:${columnLetter(LOG_WIDTH - 1)}${foot + plan.appends.length - 1}`, plan.appends.map((append) => append.cells));
      }
      const keys = Object.keys(plan.written);
      const snapshot = {
        rows: keys.map((key) => plan.written[key]) as unknown as Prisma.InputJsonValue,
        keys: keys as unknown as Prisma.InputJsonValue,
        bold: [],
        editable: tab.editable as unknown as Prisma.InputJsonValue,
      };
      await this.prisma.excelSyncSheet.upsert({
        where: { organizationId_name: { organizationId, name } },
        create: { organizationId, name, origin, ...snapshot },
        update: snapshot,
      });
      results.push({ name, created: false, rowsWritten: new Set(plan.writes.map((write) => write.row)).size + plan.appends.length + plan.clears.length });
    }
    return { tabs: results, pull: { taken: taken + added, conflicts }, deferred };
  }

  /** Rows the office added to a log tab, into the console as rows of the office's own -- as the workbook import makes them. */
  private async addOfficeRows(
    organizationId: string,
    account: string | null,
    rows: { tab: string; technicianId: string; date: string; cells: LogTabPlan['added'][number]['cells'] }[],
  ) {
    if (!rows.length) return 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.revenueLogEntry.createMany({
        data: rows.map(({ technicianId, date, cells }) => ({
          organizationId,
          technicianId,
          day: new Date(`${date}T00:00:00.000Z`),
          ...cells,
          rescheduleOn: cells.rescheduleOn ? new Date(`${cells.rescheduleOn}T00:00:00.000Z`) : null,
          importedFields: Object.fromEntries(Object.entries(cells).filter(([, value]) => value !== null)) as Prisma.InputJsonValue,
          updatedById: null,
        })),
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: null,
          action: 'REVENUE_EXCEL_ROWS_ADDED',
          entityType: 'ExcelSync',
          entityId: organizationId,
          metadata: { account, rows: rows.map(({ tab, date, cells }) => ({ tab, date, jobNumber: cells.jobNumber, address: cells.address })) } as unknown as Prisma.InputJsonValue,
        },
      });
    });
    this.live?.publishChange(organizationId, { scope: 'log', cells: [], by: { userId: 'excel', name: 'Excel' } });
    return rows.length;
  }

  /** Cells into a range: a number in its format; words as General, so a formula typed there later works -- Text only where Excel would misread them (`formatOf`). */
  private putCells(client: ExcelGraphClient, name: string, address: string, cells: ExcelCell[][]) {
    return client.writeRange(
      name,
      address,
      cells.map((row) => row.map((cell) => (typeof cell === 'string' ? cell : cell.value))),
      cells.map((row) => row.map(formatOf)),
    );
  }

  /**
   * "Fix formulas in Excel" (2026-11-18): put right the Text format the
   * console once gave its cells, whether the sync is on or not -- every tab it
   * wrote, as far as one run's calls go; the next press, or the next run,
   * carries on.
   */
  async repairNow(user: AuthenticatedUser): Promise<ExcelFormulaRepair> {
    const organizationId = user.organizationId;
    const [sync, connection] = await Promise.all([
      this.prisma.excelSync.findUnique({ where: { organizationId } }),
      this.prisma.microsoftConnection.findUnique({ where: { organizationId }, select: { status: true } }),
    ]);
    if (!sync) throw new ApplicationError(409, 'EXCEL_NOT_LINKED', 'No workbook is linked.');
    if (connection?.status !== 'CONNECTED') throw new ApplicationError(409, 'MICROSOFT_NOT_CONNECTED', 'Connect the Microsoft account again to write the workbook.');
    if (!(await this.claim(organizationId))) throw new ApplicationError(409, 'EXCEL_SYNC_RUNNING', 'The workbook is being written now. It is done within a minute.');
    const client = new ExcelGraphClient(this.auth, organizationId, { driveId: sync.driveId, itemId: sync.itemId });
    try {
      await client.openSession();
      try {
        const existing = new Set(await client.worksheetNames());
        const snapshots = new Map((await this.prisma.excelSyncSheet.findMany({ where: { organizationId } })).map((sheet) => [sheet.name, sheet]));
        const repair = await this.repairPending(client, snapshots, existing, this.auth.config().callsPerRun - 1);
        await this.recordRepair(organizationId, auditActor(user).actorUserId, repair);
        return repair;
      } finally {
        await client.closeSession();
      }
    } finally {
      await this.prisma.excelSync.update({ where: { organizationId }, data: { claimedUntil: null } });
    }
  }

  /**
   * Each tab the console wrote, once: its Text cells made General where they
   * need not be Text (what they hold stays as it is), and a formula typed into
   * one -- kept by Excel as words -- entered again for Excel to work out
   * (`repairFormats`). Only the cells the console wrote: a log tab from where
   * its rows begin. Stops short of `calls`, leaving the rest waiting.
   */
  private async repairPending(client: ExcelGraphClient, snapshots: Map<string, ExcelSyncSheet>, existing: ReadonlySet<string>, calls: number) {
    const result: ExcelFormulaRepair = { tabs: 0, cells: 0, formulas: 0, waiting: 0 };
    for (const sheet of snapshots.values()) {
      if (sheet.formatsCheckedAt) continue;
      // Each tab: its last row (a log tab), one read, its formats, and two calls a formula.
      if (client.callsMade + 4 > calls) {
        result.waiting += 1;
        continue;
      }
      try {
        const region = existing.has(sheet.name) ? await this.writtenRegion(client, sheet) : null;
        let done = true;
        // A tab of the console's own: the cells the office links with a formula -- "='Amy'!E418" -- remembered, never
        // to be written over.
        let formulaCells: [number, number][] | undefined;
        if (region) {
          const read = await client.readCells(sheet.name, region.address);
          const fix = repairFormats(read);
          if (typeof sheet.origin !== 'number')
            formulaCells = [
              ...((sheet.formulaCells as [number, number][] | null) ?? []),
              ...read.formulas.flatMap((cells, row) =>
                cells.flatMap((formula, column) => (isFormula(formula, read.values[row]?.[column] ?? null) ? [[row, column] as [number, number]] : [])),
              ),
              ...fix.formulas.map(({ row, column }): [number, number] => [row, column]),
            ];
          // The formulas first, each made General and entered again: a run that stops part-way leaves the rest
          // still Text, for the next to find.
          for (const formula of fix.formulas) {
            if (client.callsMade + 3 > calls) {
              done = false;
              break;
            }
            const cell = `${columnLetter(region.left + formula.column)}${region.top + formula.row}`;
            await client.setNumberFormat(sheet.name, `${cell}:${cell}`, [['General']]);
            await client.writeFormulas(sheet.name, `${cell}:${cell}`, [[formula.formula]]);
            result.formulas += 1;
          }
          if (done && fix.formats) {
            await client.setNumberFormat(sheet.name, region.address, fix.formats);
            result.cells += fix.formats.flat().filter((format, index) => format !== read.numberFormat.flat()[index]).length - fix.formulas.length;
          }
        }
        if (!done) {
          result.waiting += 1;
          continue;
        }
        const now = new Date();
        await this.prisma.excelSyncSheet.update({
          where: { organizationId_name: { organizationId: sheet.organizationId, name: sheet.name } },
          data: { formatsCheckedAt: now, ...(formulaCells ? { formulaCells: formulaCells as unknown as Prisma.InputJsonValue } : {}) },
        });
        if (formulaCells) sheet.formulaCells = formulaCells as unknown as Prisma.JsonValue;
        sheet.formatsCheckedAt = now;
        result.tabs += 1;
      } catch (error) {
        if (error instanceof MicrosoftError && (error.code === 'MICROSOFT_RATE_LIMITED' || error.code === 'EXCEL_RUN_BUDGET_SPENT')) {
          result.waiting += 1;
          break;
        }
        // Anything else is not tried again run after run: the tab is left as it is, and said so.
        this.logger.warn({ event: 'excel_formats_repair_failed', tab: sheet.name, error: error instanceof Error ? error.message : String(error) });
        await this.prisma.excelSyncSheet
          .update({ where: { organizationId_name: { organizationId: sheet.organizationId, name: sheet.name } }, data: { formatsCheckedAt: new Date() } })
          .catch(() => undefined);
        sheet.formatsCheckedAt = new Date();
      }
    }
    return { ...result, pending: result.waiting > 0 };
  }

  /** The cells the console wrote on a tab: a log tab's from where its rows begin to its last row; another tab's from A1. */
  private async writtenRegion(client: ExcelGraphClient, sheet: ExcelSyncSheet) {
    if (typeof sheet.origin === 'number') {
      const last = await client.lastUsedRow(sheet.name);
      if (last <= sheet.origin) return null;
      return { address: `A${sheet.origin + 1}:${columnLetter(LOG_WIDTH - 1)}${last}`, top: sheet.origin + 1, left: 0 };
    }
    const rows = (sheet.rows ?? []) as ExcelCell[][];
    const width = Math.max(0, ...rows.map((row) => row.length));
    if (!rows.length || !width) return null;
    return { address: `A1:${columnLetter(width - 1)}${rows.length}`, top: 1, left: 0 };
  }

  private async recordRepair(organizationId: string, actorUserId: string | null, repair: ExcelFormulaRepair) {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId,
        action: 'EXCEL_FORMATS_REPAIRED',
        entityType: 'ExcelSync',
        entityId: organizationId,
        metadata: { tabs: repair.tabs, cells: repair.cells, formulas: repair.formulas, waiting: repair.waiting },
      },
    });
  }

  private snapshotOf(tab: ExcelTab) {
    return {
      origin: tab.below?.origin ?? null,
      rows: tab.rows as unknown as Prisma.InputJsonValue,
      bold: tab.bold,
      keys: tab.keys as unknown as Prisma.InputJsonValue,
      editable: tab.editable as unknown as Prisma.InputJsonValue,
    };
  }

  /**
   * Save what the office typed in Excel, as it would have typed it on the
   * page: on the day's, week's or month's entry, on everyone's page at once,
   * and on the record -- from Excel, through the connected account; Excel
   * knows no console user to name. Returns how many cells came in.
   */
  private async takeEdits(organizationId: string, account: string | null, edits: (ExcelEdit & { tab: string })[]) {
    // A day's budget and work time are on two tabs: when both changed, the last read stands.
    const byCell = new Map(edits.map((edit) => [`${edit.key}|${edit.field}`, edit]));
    if (!byCell.size) return 0;
    const told = new Map<RevenueLiveScope, string[]>();
    const tell = (scope: RevenueLiveScope, cell: string) => told.set(scope, [...(told.get(scope) ?? []), cell]);
    await this.prisma.$transaction(async (tx) => {
      for (const edit of byCell.values()) {
        const [kind, technicianId, when] = edit.key.split('|') as [string, string, string];
        if (kind === 'log') {
          // "log|visit|<visit>|<technician>|<day>" or "log|entry|<entry>": a log row's typed cell.
          const [, which, id, technician, date] = edit.key.split('|') as [string, string, string, string?, string?];
          const value = edit.field === 'rescheduleOn' && typeof edit.value === 'string' ? new Date(`${edit.value}T00:00:00.000Z`) : edit.value;
          const cells = { [edit.field]: value, updatedById: null };
          if (which === 'visit')
            await tx.revenueLogEntry.upsert({
              where: { inspectionId: id },
              create: { organizationId, technicianId: technician!, inspectionId: id, day: new Date(`${date}T00:00:00.000Z`), ...cells },
              update: cells,
            });
          else await tx.revenueLogEntry.updateMany({ where: { id, organizationId }, data: cells });
          tell('log', revenueCell.log(id, edit.field));
          continue;
        }
        const data = { [edit.field]: edit.value, updatedById: null };
        const day = new Date(`${kind === 'month' ? `${when}-01` : when}T00:00:00.000Z`);
        if (kind === 'day') {
          await tx.revenueDayEntry.upsert({
            where: { technicianId_day: { technicianId, day } },
            create: { organizationId, technicianId, day, ...data },
            update: data,
          });
          tell('day', revenueCell.day(technicianId, when, edit.field));
        } else if (kind === 'week') {
          await tx.revenueWeekEntry.upsert({
            where: { technicianId_weekStart: { technicianId, weekStart: day } },
            create: { organizationId, technicianId, weekStart: day, ...data },
            update: data,
          });
          tell('week', revenueCell.week(technicianId, when, edit.field));
        } else if (kind === 'month') {
          await tx.revenueMonthEntry.upsert({
            where: { technicianId_month: { technicianId, month: day } },
            create: { organizationId, technicianId, month: day, ...data },
            update: data,
          });
          tell('month', revenueCell.month(technicianId, when, edit.field));
        }
      }
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: null,
          action: 'REVENUE_EXCEL_EDITS_TAKEN',
          entityType: 'ExcelSync',
          entityId: organizationId,
          metadata: { account, edits: [...byCell.values()].map(({ tab, key, field, from, to }) => ({ tab, key, field, from, to })) },
        },
      });
    });
    for (const [scope, cells] of told) this.live?.publishChange(organizationId, { scope, cells, by: { userId: 'excel', name: 'Excel' } });
    return byCell.size;
  }

  private async writeTab(
    client: ExcelGraphClient,
    tab: ExcelTab,
    exists: boolean,
    before: { rows: ExcelCell[][]; bold: number[] } | null,
    /** The office's cells ([row, column]) -- changed in Excel, or a formula: never written over. */
    officeCells: [number, number][] = [],
  ): Promise<{ created: boolean; rowsWritten: number }> {
    const kept = new Set(officeCells.map(([row, column]) => `${row},${column}`));
    const width = Math.max(...tab.rows.map((row) => row.length), ...(before?.rows ?? []).map((row) => row.length), 1);
    const pad = (row: ExcelCell[] | undefined) => Array.from({ length: width }, (_, index): ExcelCell => row?.[index] ?? '');
    const last = columnLetter(width - 1);
    const rows = tab.rows.map(pad);
    // The sheet row (1-based) of the tab's row `index`: a log tab's rows start under the office's.
    const at = (index: number) => (tab.below?.origin ?? 0) + index + 1;
    const line = (index: number) => `A${at(index)}:${last}${at(index)}`;
    const look = async (index: number, on: boolean) => {
      await client.bold(tab.name, line(index), on);
      if (tab.fill) await client.fill(tab.name, line(index), on ? tab.fill : null);
    };
    // A number in its format; words as General -- Text only where Excel would misread them -- so a formula the
    // office types into a cell later works (`formatOf`).
    const put = (address: string, cells: ExcelCell[][]) =>
      client.writeRange(
        tab.name,
        address,
        cells.map((row) => row.map((cell) => (typeof cell === 'string' ? cell : cell.value))),
        cells.map((row) => row.map(formatOf)),
      );

    if (!exists || !before) {
      // A tab the console has not written before: all of it, in one call. A log tab is the office's, and stays as
      // the office sized it.
      if (!rows.length) return { created: false, rowsWritten: 0 };
      if (!exists) await client.addWorksheet(tab.name);
      await put(`A${at(0)}:${last}${at(rows.length - 1)}`, rows);
      for (const index of tab.bold) await look(index, true);
      if (!tab.below) await client.autofitColumns(tab.name, `A1:${last}${rows.length}`);
      return { created: !exists, rowsWritten: rows.length };
    }

    // Only the cells that differ from what the tab holds, as a person editing the sheet changes them: a run of
    // them side by side in a row in one call, and nothing else in the row touched (2026-11-17, the office: "if we
    // are modifying one data it should only be that one data to be modified, just like in the excel").
    const old = before.rows.map(pad);
    // A number is the same number however its format is spelled; words are the same words.
    const same = (left: ExcelCell | undefined, right: ExcelCell | undefined) =>
      typeof left === 'object' && typeof right === 'object'
        ? Math.abs(left.value - right.value) < 1e-9
        : JSON.stringify(left ?? '') === JSON.stringify(right ?? '') || (cellText(left) === cellText(right) && typeof left === typeof right);
    let written = 0;
    const blank = (cells: ExcelCell[] | undefined) => !cells || cells.every((cell) => cellText(cell) === '');
    const office = (index: number) => [...kept].some((cell) => cell.startsWith(`${index},`));
    for (let index = 0; index < rows.length; index++) {
      // Rows the tab did not have yet -- a new day, a new visit -- go in whole, a run of them in one call, unless the
      // office has a cell of its own there.
      if (blank(old[index]) && !blank(rows[index]) && !office(index)) {
        let end = index;
        while (end + 1 < rows.length && blank(old[end + 1]) && !blank(rows[end + 1]) && !office(end + 1)) end += 1;
        await put(`A${at(index)}:${last}${at(end)}`, rows.slice(index, end + 1));
        written += end - index + 1;
        index = end;
        continue;
      }
      const row = rows[index]!;
      let touched = false;
      // Unchanged, or the office's: left as it is.
      const leave = (column: number) => same(row[column], old[index]?.[column]) || kept.has(`${index},${column}`);
      for (let column = 0; column < width; ) {
        if (leave(column)) {
          column += 1;
          continue;
        }
        let end = column;
        while (end + 1 < width && !leave(end + 1)) end += 1;
        await put(`${columnLetter(column)}${at(index)}:${columnLetter(end)}${at(index)}`, [row.slice(column, end + 1)]);
        touched = true;
        column = end + 1;
      }
      if (touched) written += 1;
    }
    // Rows the tab no longer has: a technician taken off the sheets -- but never a row holding the office's formula.
    for (let index = rows.length; index < old.length; index++) {
      if ([...kept].some((cell) => cell.startsWith(`${index},`))) continue;
      let end = index;
      while (end + 1 < old.length && ![...kept].some((cell) => cell.startsWith(`${end + 1},`))) end += 1;
      await client.clearRange(tab.name, `A${at(index)}:${last}${at(end)}`);
      written += end - index + 1;
      index = end;
    }
    const wasBold = new Set(before.bold);
    const isBold = new Set(tab.bold);
    for (const index of before.bold) if (!isBold.has(index)) await look(index, false);
    for (const index of tab.bold) if (!wasBold.has(index)) await look(index, true);
    return { created: false, rowsWritten: written };
  }

  private async audit(user: AuthenticatedUser, action: string, metadata: Record<string, unknown>) {
    await this.prisma.auditLog.create({
      data: { organizationId: user.organizationId, ...auditActor(user), action, entityType: 'ExcelSync', entityId: user.organizationId, metadata: metadata as Prisma.InputJsonValue },
    });
  }
}
