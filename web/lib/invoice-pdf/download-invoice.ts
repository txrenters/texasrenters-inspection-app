import type { InvoiceDetail, ReceiptBrand } from '@texasrenters/shared';
import { createElement } from 'react';

import { propertyFileStem } from '@/lib/report-pdf/file-name';

/**
 * An invoice as a PDF, made in the browser on a click (2026-11-06, phase 5),
 * as a payment's receipt is: the invoice page already holds every detail it
 * prints, so nothing is asked of the server and nothing billed is called. The
 * PDF library loads only when somebody downloads or previews one.
 */

/** Who it is from when the page has not been told: the same fallback the server uses. */
const FALLBACK_BRAND: ReceiptBrand = { name: 'TexasRenters.com', addressLine1: null, addressLine2: null, phone: null, email: null };

/** `100 Example Way_Invoice 8439.pdf`, named like the reports the office files in Propertyware. */
export function invoiceFileName(invoice: Pick<InvoiceDetail, 'property' | 'clientName' | 'number' | 'issuedOn'>) {
  const stem = propertyFileStem({ name: invoice.clientName, addressLine1: invoice.property?.address ?? invoice.clientName });
  const which = invoice.number ? `Invoice ${invoice.number}` : `Invoice ${invoice.issuedOn ?? 'draft'}`;
  return `${stem ? `${stem}_` : ''}${which}.pdf`;
}

export async function invoicePdf(invoice: InvoiceDetail): Promise<Blob> {
  const [{ pdf }, { InvoiceDocument }] = await Promise.all([import('@react-pdf/renderer'), import('./invoice-document')]);
  const brand = invoice.brand ?? FALLBACK_BRAND;
  return pdf(createElement(InvoiceDocument, { invoice, brand }) as Parameters<typeof pdf>[0]).toBlob();
}

function save(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // After the click has handed the file to the browser.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

/** Saved under its file name. */
export async function downloadInvoice(invoice: InvoiceDetail) {
  save(await invoicePdf(invoice), invoiceFileName(invoice));
}

/**
 * Opened in a new tab to look at before it is sent, as Jobber's preview. The
 * tab is opened on the click, before the PDF is made, so the browser does not
 * take it for a pop-up; it is closed again if the PDF cannot be made. Where
 * the browser opens no tab at all, the PDF is saved instead, so the console
 * page -- and the send being written -- stays where it is.
 */
export async function previewInvoice(invoice: InvoiceDetail) {
  const tab = window.open('', '_blank');
  try {
    const blob = await invoicePdf(invoice);
    if (!tab) return save(blob, invoiceFileName(invoice));
    const url = URL.createObjectURL(blob);
    tab.location.href = url;
    // Long enough for the tab to load it; the tab keeps its copy.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    tab?.close();
    throw error;
  }
}
