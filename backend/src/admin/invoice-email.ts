import {
  formatMoney,
  invoiceDocumentName,
  invoiceTotalLines,
  type InvoiceDetail,
  type InvoiceTotalLine,
  type ReceiptBrand,
  accountBalanceLine,
  clientViewOf,
  showsLateStamp,
} from '@texasrenters/shared';

/**
 * The invoice as an email (2026-11-06, phase 5): the office's note, then the
 * invoice itself -- who it is for, when it is due, each line, the totals and
 * what is still owed -- then the client message and the contract text. All of
 * it written into the email rather than linked: there is no client page for a
 * link to open, and nothing private leaves in a URL. Every value is escaped.
 */

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const day = (value: string | null) => (value ? DAY.format(new Date(`${value}T12:00:00.000Z`)) : '—');

export function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** Text as paragraphs, its line breaks kept. */
export const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((part) => `<p style="margin:0 0 12px">${escapeHtml(part).replaceAll('\n', '<br>')}</p>`)
    .join('');

const cell = 'padding:8px 6px;border-bottom:1px solid #d9e2ef;text-align:left;vertical-align:top';
const money = `${cell};text-align:right;white-space:nowrap`;

/** One line of the totals; the balance due bold, set apart. */
function totalRow({ label, value, strong }: InvoiceTotalLine) {
  const top = strong ? 8 : 3;
  const look = strong ? 'font-weight:700' : 'color:#5b6b87';
  return `<tr><td style="padding:${top}px 12px 3px 0;${look}">${escapeHtml(label)}</td><td style="padding:${top}px 0 3px;text-align:right${strong ? ';font-weight:700' : ''}">${escapeHtml(value)}</td></tr>`;
}

export function invoiceEmail(invoice: InvoiceDetail, brand: ReceiptBrand, message: string | null, subject?: string) {
  const name = invoiceDocumentName(invoice);
  const details = invoice.details;
  const place = invoice.property ? [invoice.property.address, invoice.property.city].filter(Boolean).join(', ') : null;
  const totals = invoiceTotalLines(invoice);
  const balance = accountBalanceLine(invoice);
  // Jobber's "Client view" (2026-11-10): only the columns the office shows.
  const view = clientViewOf(invoice);
  const columns = [
    view.showQuantities ? { head: 'Qty', of: (line: InvoiceDetail['lineItems'][number]) => String(line.quantity) } : null,
    view.showUnitPrices ? { head: 'Unit price', of: (line: InvoiceDetail['lineItems'][number]) => formatMoney(line.unitPriceCents) } : null,
    view.showLineTotals ? { head: 'Total', of: (line: InvoiceDetail['lineItems'][number]) => formatMoney(line.totalCents) } : null,
  ].filter((column): column is NonNullable<typeof column> => column !== null);

  const lines = invoice.lineItems
    .map(
      (line) => `<tr>
        <td style="${cell}"><strong>${escapeHtml(line.name)}</strong>${
          line.description ? `<br><span style="color:#5b6b87;font-size:13px">${escapeHtml(line.description)}</span>` : ''
        }</td>
        ${columns.map((column) => `<td style="${money}">${escapeHtml(column.of(line))}</td>`).join('')}
      </tr>`,
    )
    .join('');

  const html = `${message?.trim() ? paragraphs(message.trim()) : ''}
    <p style="margin:0 0 4px"><strong>${escapeHtml(name)}</strong> for ${escapeHtml(invoice.clientName)}${
      place && place !== invoice.clientName ? ` (${escapeHtml(place)})` : ''
    }</p>
    <p style="margin:0 0 16px;color:#5b6b87">Issued ${escapeHtml(day(invoice.issuedOn))} · Due ${escapeHtml(day(invoice.dueOn))}</p>
    ${showsLateStamp(invoice) ? '<p style="margin:0 0 16px;color:#b42318;font-weight:700;letter-spacing:1px">PAST DUE</p>' : ''}
    <table style="width:100%;border-collapse:collapse;font-size:14px" role="presentation">
      <thead><tr>
        <th style="${cell}">Product / Service</th>${columns.map((column) => `<th style="${money}">${column.head}</th>`).join('')}
      </tr></thead>
      <tbody>${lines}</tbody>
    </table>
    <table style="margin:12px 0 0 auto;border-collapse:collapse;font-size:14px" role="presentation">
      ${totals.map(totalRow).join('')}${balance ? totalRow(balance) : ''}
    </table>
    ${invoice.clientMessage ? `<div style="margin-top:20px">${paragraphs(invoice.clientMessage)}</div>` : ''}
    ${details?.contractDisclaimer ? `<div style="margin-top:12px;color:#5b6b87;font-size:13px">${paragraphs(details.contractDisclaimer)}</div>` : ''}
    <p style="margin-top:20px;color:#5b6b87;font-size:13px">${[brand.name, brand.addressLine1, brand.addressLine2, brand.phone, brand.email]
      .filter((part): part is string => Boolean(part))
      .map(escapeHtml)
      .join(' · ')}</p>`;

  return { subject: subject ?? `${name} from ${brand.name}`, title: `${name}: ${formatMoney(invoice.balanceCents)} due ${day(invoice.dueOn)}`, html };
}
