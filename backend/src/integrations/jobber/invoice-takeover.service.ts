import { Inject, Injectable } from '@nestjs/common';
import type { InvoiceTakeoverCheck, InvoiceTakeoverView, TakeOverInvoicingInput } from '@texasrenters/shared';
import { JobberConnectionStatus, Prisma } from '@prisma/client';

import { fileCopyStatus } from '../../admin/invoice-files.service';
import type { AuthenticatedUser } from '../../common/auth';
import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { JobberInvoiceWorker, type InvoiceReadResult } from '../../workers/jobber-sync/jobber-invoice.worker';

/**
 * Taking invoicing over from Jobber (2026-11-06, phase 8, the cutover).
 *
 * The take-over reads Jobber one last time -- the same bounded read the
 * scheduler runs, so it takes what changed since the last -- and only if that
 * read reaches the end, invoices and payments both, and leaves no file to
 * copy, records when the console took over and who did it. From then on the
 * invoice read stops before it asks Jobber anything, every writer of Jobber's
 * copy refuses in its own transaction, and the console's invoice writes are on.
 *
 * Undone only while nothing has been changed in the console since: after
 * that, reading Jobber again would overwrite the office's work. Both are on
 * the record. Jobber's API is not billed, and nothing is sent to it.
 */

/** Every console change to an invoice or a payment is recorded against the invoice. */
const INVOICE_ENTITY = 'Invoice';

const when = (value: Date | null) =>
  value
    ? new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Chicago',
      }).format(value)
    : null;

/**
 * The products whose invoices would reach no books once the console makes them
 * (2026-11-13): of no company, of a company no longer connected, or of one
 * whose sending is off. Such an invoice gets the console's own number and goes
 * nowhere -- and, its company's books read, nobody emails it either. Grouped by
 * why, in words.
 */
export function productsGoingNowhere(
  products: { name: string; xeroTenantId: string | null }[],
  companies: { xeroTenantId: string; name: string; status: string; settings: { sendingEnabled: boolean } | null }[],
): string[] {
  const byTenant = new Map(companies.map((company) => [company.xeroTenantId, company]));
  const why = new Map<string, string[]>();
  for (const product of products) {
    const company = product.xeroTenantId ? byTenant.get(product.xeroTenantId) : undefined;
    const reason = !product.xeroTenantId
      ? 'no company'
      : !company || company.status !== 'CONNECTED'
        ? `${company?.name ?? 'a company'}, not connected`
        : !company.settings?.sendingEnabled
          ? `${company.name}, sending off`
          : null;
    if (reason) why.set(reason, [...(why.get(reason) ?? []), product.name]);
  }
  return [...why].map(([reason, names]) => `${names.join(', ')} (${reason})`);
}

const PROBLEM: Record<string, string> = {
  NOT_PERMITTED: 'Jobber refuses the console its invoices: the connection lacks the invoice permission.',
  FAILED: 'The last read of Jobber failed.',
};

@Injectable()
export class InvoiceTakeoverService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberInvoiceWorker) private readonly invoices: JobberInvoiceWorker,
  ) {}

  async view(user: AuthenticatedUser): Promise<InvoiceTakeoverView> {
    const org = user.organizationId;
    const settings = await this.prisma.invoiceSettings.findUnique({
      where: { organizationId: org },
      select: { companyName: true, invoicingTakenOverAt: true, invoicingTakenOverBy: { select: { id: true, displayName: true } } },
    });
    const takenOverAt = settings?.invoicingTakenOverAt ?? null;
    if (takenOverAt) {
      const changesSince = await this.changesSince(org, takenOverAt);
      return {
        takenOverAt: takenOverAt.toISOString(),
        takenOverBy: settings?.invoicingTakenOverBy ?? null,
        changesSince,
        undoable: changesSince === 0,
        checks: [],
        ready: false,
        failedFiles: 0,
      };
    }

    // The companies that send to Xero (2026-11-12): their books must be read back first, so their invoices show as Xero
    // has them and the console sends them nothing Xero sends -- follow-ups start at the switch.
    const sending = await this.prisma.xeroSettings.findMany({
      where: { organizationId: org, sendingEnabled: true, xeroOrganisation: { status: 'CONNECTED' } },
      select: { booksReadAt: true, xeroOrganisation: { select: { name: true } } },
    });
    const unread = sending.filter((row) => !row.booksReadAt).map((row) => row.xeroOrganisation.name);

    const [connection, files, products, companies] = await Promise.all([
      this.prisma.jobberConnection.findUnique({
        where: { organizationId: org },
        select: {
          status: true,
          invoiceReadCompletedAt: true,
          invoiceReadCheckedAt: true,
          invoiceReadProblem: true,
          paymentReadCompletedAt: true,
        },
      }),
      fileCopyStatus(this.prisma, org),
      this.prisma.invoiceProduct.findMany({ where: { organizationId: org, active: true }, select: { name: true, xeroTenantId: true }, orderBy: { name: 'asc' } }),
      this.prisma.xeroOrganisation.findMany({
        where: { organizationId: org },
        select: { xeroTenantId: true, name: true, status: true, settings: { select: { sendingEnabled: true } } },
      }),
    ]);
    const nowhere = productsGoingNowhere(products, companies);
    const connected = connection?.status === JobberConnectionStatus.CONNECTED;
    // Jobber's checks hold the switch back only while Jobber is connected (2026-11-12): then it is read one last time,
    // for invoices made there just before. Not connected, the console makes invoices without it.
    const checks: InvoiceTakeoverCheck[] = [
      {
        key: 'JOBBER_ANSWERS',
        ok: connected && !connection?.invoiceReadProblem,
        blocking: connected,
        label: 'Jobber is connected and answering',
        detail: !connected
          ? 'Jobber is not connected: the console makes invoices without a last read of it.'
          : connection?.invoiceReadProblem
            ? (PROBLEM[connection.invoiceReadProblem] ?? 'The last read of Jobber failed.')
            : connection?.invoiceReadCheckedAt
              ? `Last read ${when(connection.invoiceReadCheckedAt)}.`
              : null,
      },
      {
        key: 'INVOICES_READ',
        ok: Boolean(connection?.invoiceReadCompletedAt),
        label: 'Every invoice has been read from Jobber',
        blocking: connected,
        detail: connection?.invoiceReadCompletedAt ? null : 'The first read of every invoice is still going.',
      },
      {
        key: 'PAYMENTS_READ',
        ok: Boolean(connection?.paymentReadCompletedAt),
        blocking: connected,
        label: "Every payment's method has been read",
        detail: connection?.paymentReadCompletedAt ? null : "Jobber's payment list is still being read.",
      },
      {
        key: 'FILES_COPIED',
        ok: files.waiting === 0,
        blocking: connected,
        label: 'Every file has been copied, or tried',
        detail: `${files.kept.toLocaleString('en-US')} of ${files.total.toLocaleString('en-US')} kept${
          files.waiting ? `; ${files.waiting.toLocaleString('en-US')} still to copy` : ''
        }.`,
      },
      {
        key: 'FILES_FAILED',
        ok: files.failed === 0,
        blocking: false,
        label: 'No file failed to copy',
        detail: files.failed
          ? `${files.failed.toLocaleString('en-US')} could not be copied: they open from Jobber only while it lasts. Save them by hand first, or say they can be left.`
          : null,
      },
      {
        key: 'COMPANY_DETAILS',
        ok: Boolean(settings?.companyName?.trim()),
        blocking: false,
        label: 'Company details are filled in',
        detail: settings?.companyName?.trim() ? null : "Invoices print the server's company details until they are.",
      },
      {
        key: 'PRODUCTS_GO_TO_XERO',
        ok: nowhere.length === 0,
        blocking: true,
        label: "Each product's company sends to Xero",
        detail: nowhere.length
          ? `${nowhere.join('; ')}. Turn sending on for its company on the Xero page, give the product a company in Invoices → Settings, or set it aside.`
          : null,
      },
      {
        key: 'XERO_BOOKS_READ',
        ok: unread.length === 0,
        blocking: true,
        label: 'Each company that sends to Xero has its books read back from there',
        detail: unread.length ? `Still being read: ${unread.join(', ')}. It reads every hour; or read now on the Xero page.` : null,
      },
    ];
    return {
      takenOverAt: null,
      takenOverBy: null,
      changesSince: 0,
      undoable: false,
      checks,
      ready: checks.every((check) => check.ok || !check.blocking),
      failedFiles: files.failed,
      jobberConnected: connected,
    };
  }

  async takeOver(user: AuthenticatedUser, input: TakeOverInvoicingInput): Promise<InvoiceTakeoverView> {
    const org = user.organizationId;
    const before = await this.view(user);
    if (before.takenOverAt) throw this.already();
    const waiting = before.checks.find((check) => check.blocking && !check.ok);
    if (waiting) throw new ApplicationError(409, 'INVOICE_TAKEOVER_NOT_READY', `Not yet: ${waiting.detail ?? waiting.label}`);
    if (before.failedFiles && !input.acceptFailedFiles)
      throw new ApplicationError(
        422,
        'INVOICE_TAKEOVER_FILES',
        `${before.failedFiles} files could not be copied. Say they can be left before taking over.`,
      );

    // One last read, while Jobber is connected: what changed there since the scheduler's. Not connected (2026-11-12),
    // there is nothing more to read.
    const read = before.jobberConnected ? await this.invoices.run(org) : null;
    const refusal = read ? lastReadProblem(read) : null;
    if (refusal) throw new ApplicationError(409, 'INVOICE_TAKEOVER_LAST_READ', `${refusal} Nothing was changed.`);
    // A file the last read found would never be copied after the cutover.
    const files = await fileCopyStatus(this.prisma, org);
    if (read && files.waiting)
      throw new ApplicationError(
        409,
        'INVOICE_TAKEOVER_NOT_READY',
        `The last read found ${files.waiting} files to copy. They are copied within a few minutes; try again then.`,
      );

    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        const row = await tx.invoiceSettings.findUnique({ where: { organizationId: org }, select: { invoicingTakenOverAt: true } });
        if (row?.invoicingTakenOverAt) throw this.already();
        if (row) {
          const { count } = await tx.invoiceSettings.updateMany({
            where: { organizationId: org, invoicingTakenOverAt: null },
            data: { invoicingTakenOverAt: now, invoicingTakenOverById: user.id },
          });
          if (count !== 1) throw this.already();
        } else await tx.invoiceSettings.create({ data: { organizationId: org, invoicingTakenOverAt: now, invoicingTakenOverById: user.id } });
        await tx.auditLog.create({
          data: {
            organizationId: org,
            actorUserId: user.id,
            action: 'INVOICING_TAKEN_OVER',
            entityType: 'InvoiceSettings',
            entityId: org,
            metadata: {
              lastRead: read ? { pages: read.pages, created: read.created, updated: read.updated, paymentPages: read.paymentPages } : null,
              files: { total: files.total, kept: files.kept, failed: files.failed },
              acceptedFailedFiles: files.failed > 0,
            },
          },
        });
      });
    } catch (error) {
      // Two at once: the other one took it over.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw this.already();
      throw error;
    }
    return this.view(user);
  }

  async undo(user: AuthenticatedUser): Promise<InvoiceTakeoverView> {
    const org = user.organizationId;
    const row = await this.prisma.invoiceSettings.findUnique({ where: { organizationId: org }, select: { invoicingTakenOverAt: true } });
    const takenOverAt = row?.invoicingTakenOverAt;
    if (!takenOverAt) throw new ApplicationError(409, 'INVOICING_NOT_TAKEN_OVER', 'Jobber still holds the invoices: there is nothing to undo.');
    const changes = await this.changesSince(org, takenOverAt);
    if (changes)
      throw new ApplicationError(
        409,
        'INVOICE_TAKEOVER_NOT_UNDOABLE',
        `${changes} changes were made to invoices in the console since; reading Jobber again would overwrite them.`,
      );
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invoiceSettings.updateMany({
        where: { organizationId: org, invoicingTakenOverAt: takenOverAt },
        data: { invoicingTakenOverAt: null, invoicingTakenOverById: null },
      });
      if (count !== 1) throw new ApplicationError(409, 'INVOICE_TAKEOVER_CHANGED', 'It changed meanwhile. Look again.');
      // A change made in between would be overwritten by the next read: not undone then.
      if (await this.changesSince(org, takenOverAt, tx))
        throw new ApplicationError(409, 'INVOICE_TAKEOVER_NOT_UNDOABLE', 'An invoice was changed meanwhile; it stays taken over.');
      await tx.auditLog.create({
        data: {
          organizationId: org,
          actorUserId: user.id,
          action: 'INVOICING_TAKEOVER_UNDONE',
          entityType: 'InvoiceSettings',
          entityId: org,
          metadata: { takenOverAt: takenOverAt.toISOString() },
        },
      });
    });
    return this.view(user);
  }

  private changesSince(organizationId: string, since: Date, db: Prisma.TransactionClient = this.prisma) {
    return db.auditLog.count({ where: { organizationId, entityType: INVOICE_ENTITY, createdAt: { gt: since } } });
  }

  private already() {
    return new ApplicationError(409, 'INVOICING_ALREADY_TAKEN_OVER', 'The console already owns invoicing.');
  }
}

/** Why the last read does not let the cutover happen, in words; null when it reached the end. */
export function lastReadProblem(read: InvoiceReadResult): string | null {
  if (read.skipped === 'NOT_CONNECTED') return 'Jobber is not connected.';
  if (read.skipped === 'WAITING' || read.problem) return PROBLEM[read.problem ?? 'FAILED'] ?? 'The last read of Jobber failed.';
  if (read.skipped === 'TAKEN_OVER') return 'The console already owns invoicing.';
  if (read.mode !== 'changed' || !read.caughtUp) return 'Jobber has more changes than one read takes. Try again in a few minutes.';
  if (!read.paymentsCaughtUp) return "Jobber's payments have more to read than one pass takes. Try again in a few minutes.";
  return null;
}
