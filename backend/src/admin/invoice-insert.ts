import { dueOnFor, invoiceTotals, lineTotalCents, type InvoiceLineInput } from '@texasrenters/shared';
import { InvoiceOrigin, InvoiceStatus, type Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { nextInvoiceNumber } from './invoice-numbers';

/**
 * One invoice made in the console, its lines and its record (2026-11-06): for
 * a visit, for a property no visit covers, or one of a batch. Totals worked
 * out from the lines; numbered next in the office's sequence unless it is a
 * draft, which is numbered when it is marked sent. Run in the caller's
 * transaction, so the number, the invoice and its record are one write.
 */
export interface ConsoleInvoice {
  subject: string;
  clientName: string;
  inspectionId: string | null;
  propertywareBuildingId: string;
  jobberJobId: string | null;
  /** `YYYY-MM-DD` */
  issuedOn: string;
  paymentTermsDays: number;
  lines: InvoiceLineInput[];
  clientMessage: string | null;
  /** The office's contract / disclaimer text at its foot, from its settings (2026-11-06). */
  contractDisclaimer?: string | null;
  clientRequestId: string;
  asDraft: boolean;
  /** The batch it was made in, for its record. */
  batchKey?: string;
  /** The company's books it goes to (2026-11-10): an organisation of the office, decided by the caller; null or left out for none. */
  xeroTenantId?: string | null;
}

const dateOf = (value: string) => new Date(`${value}T00:00:00.000Z`);

export async function insertConsoleInvoice(tx: Prisma.TransactionClient, user: AuthenticatedUser, invoice: ConsoleInvoice) {
  const lines = invoice.lines.map((line) => ({
    name: line.name.trim(),
    description: line.description?.trim() || null,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
  }));
  const { subtotalCents, totalCents } = invoiceTotals(lines);
  const number = invoice.asDraft ? null : await nextInvoiceNumber(tx, user.organizationId);
  const created = await tx.invoice.create({
    data: {
      organizationId: user.organizationId,
      origin: InvoiceOrigin.CONSOLE,
      number,
      subject: invoice.subject,
      status: invoice.asDraft ? InvoiceStatus.DRAFT : InvoiceStatus.AWAITING_PAYMENT,
      clientName: invoice.clientName,
      inspectionId: invoice.inspectionId,
      propertywareBuildingId: invoice.propertywareBuildingId,
      jobberJobId: invoice.jobberJobId,
      issuedOn: dateOf(invoice.issuedOn),
      dueOn: dateOf(dueOnFor(invoice.issuedOn, invoice.paymentTermsDays)),
      paymentTermsDays: invoice.paymentTermsDays,
      subtotalCents,
      taxCents: 0,
      totalCents,
      balanceCents: totalCents,
      clientMessage: invoice.clientMessage,
      contractDisclaimer: invoice.contractDisclaimer ?? null,
      createdById: user.id,
      clientRequestId: invoice.clientRequestId,
      xeroTenantId: invoice.xeroTenantId ?? null,
      lines: {
        create: lines.map((line, position) => ({
          organizationId: user.organizationId,
          position,
          ...line,
          totalCents: lineTotalCents(line),
        })),
      },
    },
    select: { id: true },
  });
  await tx.auditLog.create({
    data: {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'INVOICE_CREATED',
      entityType: 'Invoice',
      entityId: created.id,
      metadata: {
        inspectionId: invoice.inspectionId,
        propertywareBuildingId: invoice.propertywareBuildingId,
        number,
        draft: invoice.asDraft,
        totalCents,
        lineCount: lines.length,
        issuedOn: invoice.issuedOn,
        paymentTermsDays: invoice.paymentTermsDays,
        clientRequestId: invoice.clientRequestId,
        xeroTenantId: invoice.xeroTenantId ?? null,
        ...(invoice.batchKey ? { batch: invoice.batchKey } : {}),
      },
    },
  });
  return { id: created.id, number, totalCents };
}
