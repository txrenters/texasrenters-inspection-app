import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MAX_LOG_DAYS, firstName, monthEnd, revenueCell, weekOf, type ExcelPull, type ExcelSyncRun, type ExcelSyncView, type RevenueLiveScope, type SaveExcelSyncInput } from '@texasrenters/shared';
import type { Prisma } from '@prisma/client';

import { auditActor, type AuthenticatedUser } from '../../common/auth';
import { businessDate } from '../../common/business-day';
import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ActualVsBudgetGateway } from '../actual-vs-budget.gateway';
import { ActualVsBudgetService } from '../actual-vs-budget.service';
import { columnLetter, dailyTab, logTab, monthTab, projectionTab, trackerTab, weekTab, type ExcelCell, type ExcelEditableField, type ExcelTab } from '../excel-layout';
import { ExcelGraphClient } from './excel-graph.client';
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
 * the console's log from that day on, under the office's rows (2026-11-18).
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
/** Read past a tab's last row, so a row the office added under it is seen. */
const EXTRA_ROWS_READ = 3;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
/** A range as read, without the empty rows under its last filled one. */
const trimEmptyRows = (rows: string[][]) => {
  let last = rows.length;
  while (last > 0 && rows[last - 1]!.every((cell) => !cell.trim())) last -= 1;
  return rows.slice(0, last);
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
      await this.prisma.excelSync.update({ where: { organizationId }, data: { lastError: message.slice(0, 500), claimedUntil: null } });
      throw error;
    }
  }

  /**
   * The tabs that should be in the workbook now, as the console shows them.
   * With the workbook's tab names, each technician whose first name is a tab
   * of it -- "Amy", "Kevin", as the office named them -- gets their log there,
   * from the sync's first day to tomorrow.
   */
  async tabsFor(organizationId: string, today = businessDate(), sheetNames?: ReadonlySet<string>): Promise<ExcelTab[]> {
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
        for (let from = start; from <= tomorrow; from = shiftDay(from, MAX_LOG_DAYS)) {
          const to = [shiftDay(from, MAX_LOG_DAYS - 1), tomorrow].sort()[0]!;
          days.push(...(await this.revenue.log(reader, { technicianId: technician.id, from, to })).days);
        }
        tabs.push(logTab(name, technician.id, days));
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
    await client.openSession();
    try {
      const existing = new Set(await client.worksheetNames());
      let tabs = await this.tabsFor(organizationId, undefined, existing);
      const snapshots = new Map(
        (await this.prisma.excelSyncSheet.findMany({ where: { organizationId, name: { in: tabs.map((tab) => tab.name) } } })).map((sheet) => [sheet.name, sheet]),
      );
      // What each tab holds now, where it was read: the write sends whatever differs from it.
      const held = new Map<string, ExcelCell[][]>();
      // A log tab's rows start where they did; the first time, under the office's last row, one row down.
      const place = async (tab: ExcelTab) => {
        if (!tab.below) return;
        tab.below.origin = snapshots.get(tab.name)?.origin ?? (await client.lastUsedRow(tab.name)) + 1;
      };
      for (const tab of tabs) await place(tab);

      if (edited) {
        const pull: ExcelPull = { at: new Date().toISOString(), taken: 0, putBack: 0, conflicts: 0 };
        const edits: (ExcelEdit & { tab: string })[] = [];
        for (const tab of tabs) {
          const written = snapshots.get(tab.name);
          if (!written || !existing.has(tab.name)) continue;
          const rows = written.rows as ExcelCell[][];
          const width = Math.max(...rows.map((row) => row.length), ...tab.rows.map((row) => row.length), 1);
          const top = (tab.below?.origin ?? 0) + 1;
          const cells = await client.readCells(tab.name, `A${top}:${columnLetter(width - 1)}${top + rows.length - 1 + EXTRA_ROWS_READ}`);
          held.set(tab.name, trimEmptyRows(cells.text));
          // A tab written before the console kept whose each row is (v2.5.245 and earlier) takes the rows of the
          // tab as it is now, when there are as many; their names are checked against Excel's all the same.
          // Otherwise anything changed in it is simply put back.
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
          pull.putBack += read.putBack;
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
          tabs = await this.tabsFor(organizationId, undefined, existing);
          for (const tab of tabs) await place(tab);
        }
      }

      for (const tab of tabs) {
        const before = snapshots.get(tab.name);
        const holds = held.get(tab.name) ?? (before?.rows as ExcelCell[][] | undefined);
        const written = await this.writeTab(
          client,
          tab,
          existing.has(tab.name),
          holds ? { rows: holds, bold: (before?.bold as number[] | undefined) ?? [] } : null,
        );
        if (written.rowsWritten || written.created || !before?.keys)
          await this.prisma.excelSyncSheet.upsert({
            where: { organizationId_name: { organizationId, name: tab.name } },
            create: { organizationId, name: tab.name, ...this.snapshotOf(tab) },
            update: this.snapshotOf(tab),
          });
        run.tabs.push({ name: tab.name, ...written });
      }
    } finally {
      await client.closeSession();
    }
    // The version the console's own write left: a different one next time is the office's edit.
    const fileTag = await client.fileTag().catch(() => null);
    await this.prisma.excelSync.update({ where: { organizationId }, data: { fileTag } });
    run.calls = client.callsMade;
    return run;
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
  ): Promise<{ created: boolean; rowsWritten: number }> {
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
    // A number in its format; text as text ("@"), so Excel never reads "11/16/2026" or "-" as something else.
    // Text kept from running as a formula keeps its apostrophe under General, where Excel hides it.
    const put = (address: string, cells: ExcelCell[][]) =>
      client.writeRange(
        tab.name,
        address,
        cells.map((row) => row.map((cell) => (typeof cell === 'string' ? cell : cell.value))),
        cells.map((row) => row.map((cell) => (typeof cell === 'string' ? (cell.startsWith("'") ? 'General' : '@') : cell.format))),
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

    // Only the rows that differ from what was written last, a run of them in one call.
    const old = before.rows.map(pad);
    let written = 0;
    for (let index = 0; index < rows.length; ) {
      if (JSON.stringify(rows[index]) === JSON.stringify(old[index])) {
        index += 1;
        continue;
      }
      let end = index;
      while (end + 1 < rows.length && JSON.stringify(rows[end + 1]) !== JSON.stringify(old[end + 1])) end += 1;
      await put(`A${at(index)}:${last}${at(end)}`, rows.slice(index, end + 1));
      written += end - index + 1;
      index = end + 1;
    }
    // Rows the tab no longer has: a technician taken off the sheets.
    if (old.length > rows.length) {
      await client.clearRange(tab.name, `A${at(rows.length)}:${last}${at(old.length - 1)}`);
      written += old.length - rows.length;
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
