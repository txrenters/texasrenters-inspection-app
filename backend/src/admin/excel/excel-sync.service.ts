import { Inject, Injectable, Logger } from '@nestjs/common';
import { monthEnd, weekOf, type ExcelSyncRun, type ExcelSyncView, type SaveExcelSyncInput } from '@texasrenters/shared';
import type { Prisma } from '@prisma/client';

import { auditActor, type AuthenticatedUser } from '../../common/auth';
import { businessDate } from '../../common/business-day';
import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ActualVsBudgetService } from '../actual-vs-budget.service';
import { columnLetter, dailyTab, monthTab, projectionTab, trackerTab, weekTab, type ExcelCell, type ExcelTab } from '../excel-layout';
import { ExcelGraphClient } from './excel-graph.client';
import { MicrosoftAuthService, MicrosoftError } from './microsoft-auth.service';
import { microsoftConfigured } from './microsoft.config';

/**
 * Actual vs Budget kept in step with the office's own workbook (2026-11-17;
 * the office: "everything should sync on this spreadsheet also ... Both ways").
 * This is the console -> Excel half; reading the office's Excel edits back is
 * the next.
 *
 * Every save marks the office's workbook as waiting, and the next run -- the
 * scheduler's, each minute, or "Sync now" -- writes the tabs those saves show
 * in: next day's projection for today and tomorrow, the daily report and the
 * revenue tracker for yesterday and today, and the weeks and months they fall
 * in, each named and laid out as the office's own tabs. It remembers what it
 * last wrote into each tab and sends only the rows that changed, inside a
 * per-run call budget. A tab dated before the sync's first day is the office's
 * and is never written.
 */

const DAY_MS = 86_400_000;
/** With no save to write, the tabs are written again this often anyway: a new day's tabs appear by themselves. */
const QUIET_REWRITE_MS = 15 * 60_000;
const CLAIM_MS = 3 * 60_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);

@Injectable()
export class ExcelSyncService {
  private readonly logger = new Logger(ExcelSyncService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MicrosoftAuthService) private readonly auth: MicrosoftAuthService,
    @Inject(ActualVsBudgetService) private readonly revenue: ActualVsBudgetService,
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

  /** The scheduler's run for one office: only when something waits, or the tabs have not been written for a while. */
  async runIfDue(organizationId: string, now = new Date()): Promise<ExcelSyncRun | null> {
    const sync = await this.prisma.excelSync.findUnique({
      where: { organizationId },
      select: { enabled: true, dirtyAt: true, lastPushedAt: true },
    });
    if (!sync?.enabled) return null;
    const waiting = sync.dirtyAt && (!sync.lastPushedAt || sync.dirtyAt > sync.lastPushedAt);
    const stale = !sync.lastPushedAt || now.getTime() - sync.lastPushedAt.getTime() > QUIET_REWRITE_MS;
    if (!waiting && !stale) return null;
    if (!(await this.claim(organizationId))) return null;
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

  /** The tabs that should be in the workbook now, as the console shows them. */
  async tabsFor(organizationId: string, today = businessDate()): Promise<ExcelTab[]> {
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
    return tabs;
  }

  /** Write the tabs: a missing one is added; an existing one gets only the rows that changed. */
  private async write(organizationId: string): Promise<ExcelSyncRun> {
    const [sync, connection] = await Promise.all([
      this.prisma.excelSync.findUnique({ where: { organizationId } }),
      this.prisma.microsoftConnection.findUnique({ where: { organizationId }, select: { status: true } }),
    ]);
    if (!sync) throw new ApplicationError(409, 'EXCEL_NOT_LINKED', 'No workbook is linked.');
    if (connection?.status !== 'CONNECTED') throw new ApplicationError(409, 'MICROSOFT_NOT_CONNECTED', 'Connect the Microsoft account again to write the workbook.');
    const tabs = await this.tabsFor(organizationId);
    const client = new ExcelGraphClient(this.auth, organizationId, { driveId: sync.driveId, itemId: sync.itemId });
    const run: ExcelSyncRun = { tabs: [], calls: 0 };
    await client.openSession();
    try {
      const existing = new Set(await client.worksheetNames());
      const snapshots = new Map(
        (await this.prisma.excelSyncSheet.findMany({ where: { organizationId, name: { in: tabs.map((tab) => tab.name) } } })).map((sheet) => [sheet.name, sheet]),
      );
      for (const tab of tabs) {
        const before = snapshots.get(tab.name);
        const written = await this.writeTab(client, tab, existing.has(tab.name), before ? { rows: before.rows as ExcelCell[][], bold: before.bold as number[] } : null);
        if (written.rowsWritten || written.created)
          await this.prisma.excelSyncSheet.upsert({
            where: { organizationId_name: { organizationId, name: tab.name } },
            create: { organizationId, name: tab.name, rows: tab.rows as unknown as Prisma.InputJsonValue, bold: tab.bold },
            update: { rows: tab.rows as unknown as Prisma.InputJsonValue, bold: tab.bold },
          });
        run.tabs.push({ name: tab.name, ...written });
      }
    } finally {
      await client.closeSession();
      run.calls = client.callsMade;
    }
    return run;
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
      // A tab the console has not written before: all of it, in one call.
      if (!exists) await client.addWorksheet(tab.name);
      await put(`A1:${last}${rows.length}`, rows);
      for (const index of tab.bold) await client.bold(tab.name, `A${index + 1}:${last}${index + 1}`, true);
      await client.autofitColumns(tab.name, `A1:${last}${rows.length}`);
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
      await put(`A${index + 1}:${last}${end + 1}`, rows.slice(index, end + 1));
      written += end - index + 1;
      index = end + 1;
    }
    // Rows the tab no longer has: a technician taken off the sheets.
    if (old.length > rows.length) {
      await client.clearRange(tab.name, `A${rows.length + 1}:${last}${old.length}`);
      written += old.length - rows.length;
    }
    const wasBold = new Set(before.bold);
    const isBold = new Set(tab.bold);
    for (const index of before.bold) if (!isBold.has(index)) await client.bold(tab.name, `A${index + 1}:${last}${index + 1}`, false);
    for (const index of tab.bold) if (!wasBold.has(index)) await client.bold(tab.name, `A${index + 1}:${last}${index + 1}`, true);
    return { created: false, rowsWritten: written };
  }

  private async audit(user: AuthenticatedUser, action: string, metadata: Record<string, unknown>) {
    await this.prisma.auditLog.create({
      data: { organizationId: user.organizationId, ...auditActor(user), action, entityType: 'ExcelSync', entityId: user.organizationId, metadata: metadata as Prisma.InputJsonValue },
    });
  }
}
