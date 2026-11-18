import type { PurchaseOrderDetail } from '@texasrenters/shared';
import { createElement } from 'react';

/**
 * A purchase order as a PDF, made in the browser on a click (2026-11-19,
 * phase 3), as an invoice is: the order's page already holds every detail it
 * prints, so nothing is asked of the server to make it. The PDF library loads
 * only when somebody downloads or sends one.
 */

/** `PO-0009 Hill Country Supply.pdf`. */
export function orderFileName(order: Pick<PurchaseOrderDetail, 'number' | 'vendor'>) {
  const vendor = (order.vendor?.name ?? '').replace(/[^\w .,()&'-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${order.number ?? 'Purchase order draft'}${vendor ? ` ${vendor}` : ''}.pdf`;
}

export async function orderPdf(order: PurchaseOrderDetail): Promise<Blob> {
  const [{ pdf }, { PurchaseOrderDocument }] = await Promise.all([import('@react-pdf/renderer'), import('./order-document')]);
  return pdf(createElement(PurchaseOrderDocument, { order }) as Parameters<typeof pdf>[0]).toBlob();
}

/** Saved under its file name. */
export async function downloadOrder(order: PurchaseOrderDetail) {
  const url = URL.createObjectURL(await orderPdf(order));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = orderFileName(order);
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // After the click has handed the file to the browser.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

/** The PDF as the email's attachment: its name and its bytes as base64. */
export async function orderAttachment(order: PurchaseOrderDetail): Promise<{ fileName: string; contentBase64: string }> {
  const bytes = new Uint8Array(await (await orderPdf(order)).arrayBuffer());
  let binary = '';
  // In pieces: one call with every byte as an argument overflows the stack on a long order.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { fileName: orderFileName(order), contentBase64: btoa(binary) };
}
