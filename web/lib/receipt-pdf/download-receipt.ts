import type { PaymentDetail } from '@texasrenters/shared';
import { createElement } from 'react';

import { propertyFileStem } from '@/lib/report-pdf/file-name';

/**
 * A payment's receipt as a PDF, made in the browser on a click (2026-11-06).
 *
 * The payment page already holds every detail the receipt prints, so nothing
 * is asked of the server, and nothing billed is called. The PDF library is
 * loaded only when somebody downloads one, so it adds nothing to the console
 * for everybody else.
 */

/** `100 Example Way_Receipt 2026-10-20.pdf`, named like the reports the office files in Propertyware. */
export function receiptFileName(payment: Pick<PaymentDetail, 'property' | 'invoice' | 'paidOn'>) {
  const stem = propertyFileStem({ name: payment.invoice.clientName, addressLine1: payment.property?.address ?? payment.invoice.clientName });
  return `${stem ? `${stem}_` : ''}Receipt ${payment.paidOn}.pdf`;
}

export async function receiptPdf(payment: PaymentDetail): Promise<Blob> {
  const [{ pdf }, { ReceiptDocument }] = await Promise.all([import('@react-pdf/renderer'), import('./receipt-document')]);
  return pdf(createElement(ReceiptDocument, { payment }) as Parameters<typeof pdf>[0]).toBlob();
}

export async function downloadReceipt(payment: PaymentDetail) {
  const blob = await receiptPdf(payment);
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = receiptFileName(payment);
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // After the click has handed the file to the browser.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
