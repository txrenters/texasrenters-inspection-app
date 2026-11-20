import type { RequisitionDetail } from '@texasrenters/shared';
import { createElement } from 'react';

/**
 * A purchase requisition as a PDF, made in the browser on Print... (2026-11-20,
 * part 4), as an order's is: the requisition's page already holds every detail
 * it prints, so nothing is asked of the server and nothing billed is called.
 * The PDF library loads only when somebody prints one.
 */

/** `PR-00042.pdf`; a draft has no number yet. */
export function requisitionFileName(requisition: Pick<RequisitionDetail, 'number'>) {
  return `${requisition.number ?? 'Purchase requisition draft'}.pdf`;
}

export async function requisitionPdf(requisition: RequisitionDetail, printedBy?: string | null): Promise<Blob> {
  const [{ pdf }, { RequisitionDocument }] = await Promise.all([import('@react-pdf/renderer'), import('./requisition-document')]);
  return pdf(createElement(RequisitionDocument, { requisition, printedBy }) as Parameters<typeof pdf>[0]).toBlob();
}

/** Saved under its file name. */
export async function downloadRequisition(requisition: RequisitionDetail, printedBy?: string | null) {
  const url = URL.createObjectURL(await requisitionPdf(requisition, printedBy));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = requisitionFileName(requisition);
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // After the click has handed the file to the browser.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
