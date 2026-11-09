import type { StatementView } from '@texasrenters/shared';
import { createElement } from 'react';

import { propertyFileStem } from '@/lib/report-pdf/file-name';

/**
 * A statement as a PDF, made in the browser on a click (2026-11-10), as a
 * receipt and an invoice are: from the statement the server worked out,
 * nothing billed. The PDF library loads only when somebody downloads one.
 */

/** `100 Example Way_Statement 2026-11-20.pdf`, named like the reports the office files. */
export function statementFileName(view: Pick<StatementView, 'clientName' | 'address' | 'on'>) {
  const stem = propertyFileStem({ name: view.clientName, addressLine1: view.address?.split(',')[0] ?? view.clientName });
  return `${stem ? `${stem}_` : ''}Statement ${view.on}.pdf`;
}

export async function statementPdf(view: StatementView): Promise<Blob> {
  const [{ pdf }, { StatementDocument }] = await Promise.all([import('@react-pdf/renderer'), import('./statement-document')]);
  return pdf(createElement(StatementDocument, { view }) as Parameters<typeof pdf>[0]).toBlob();
}

export async function downloadStatement(view: StatementView) {
  const url = URL.createObjectURL(await statementPdf(view));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = statementFileName(view);
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
