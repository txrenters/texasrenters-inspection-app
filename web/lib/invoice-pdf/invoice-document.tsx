import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import {
  REPORT_PALETTE,
  formatMoney,
  invoiceDocumentName,
  invoiceTotalLines,
  type InvoiceDetail,
  type ReceiptBrand,
} from '@texasrenters/shared';

/**
 * An invoice as a PDF (2026-11-06, phase 5), as Jobber's "Download PDF":
 * from the company, to the client and for the property, its number and days,
 * each line, the totals with what has been paid and what is still due, then
 * the client message and the contract text. The same totals as its email
 * (`invoiceTotalLines`). No images, so it renders in the browser from what
 * the invoice page already holds.
 *
 * Laid out as the reports learned to break pages (PR #481): a line is never
 * split across two pages, the table's heading repeats, and nothing breakable
 * carries a bottom margin that could push into the footer.
 */

const C = REPORT_PALETTE;

const styles = StyleSheet.create({
  page: { paddingTop: 48, paddingBottom: 64, paddingHorizontal: 48, fontSize: 10, color: C.text, fontFamily: 'Helvetica' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  brand: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: C.brand },
  muted: { color: C.muted, marginTop: 2 },
  title: { fontSize: 22, fontFamily: 'Helvetica-Bold', color: C.brandDark, textAlign: 'right' },
  subtitle: { color: C.muted, textAlign: 'right', marginTop: 4 },
  parties: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  party: { width: '48%' },
  sectionTitle: { fontSize: 8, color: C.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  strong: { fontFamily: 'Helvetica-Bold' },
  fact: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  tableHead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.text, paddingBottom: 4, marginTop: 4 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.border, paddingVertical: 6 },
  service: { width: '52%', paddingRight: 8 },
  qty: { width: '12%', textAlign: 'right' },
  money: { width: '18%', textAlign: 'right' },
  head: { fontSize: 8, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
  totals: { marginLeft: 'auto', width: '45%', paddingTop: 10 },
  totalLine: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  due: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: C.text, marginTop: 4, paddingTop: 6 },
  dueText: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: C.brandDark },
  note: { paddingTop: 18 },
  footer: { position: 'absolute', bottom: 28, left: 48, right: 48, color: C.muted, fontSize: 8, flexDirection: 'row', justifyContent: 'space-between' },
});

/** "Dec 1, 2026": an invoice's day, which is a date and never a moment. */
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
export const invoiceDay = (day: string | null) => (day ? DAY.format(new Date(`${day}T12:00:00.000Z`)) : '—');

/** The days and terms printed beside who it is for; empty ones left out. */
export function invoiceFacts(invoice: InvoiceDetail): { label: string; value: string }[] {
  const facts = [
    { label: 'Issued', value: invoiceDay(invoice.issuedOn) },
    { label: 'Due', value: invoiceDay(invoice.dueOn) },
  ];
  if (invoice.paymentTerms) facts.push({ label: 'Terms', value: invoice.paymentTerms });
  if (invoice.jobNumber) facts.push({ label: 'Job', value: `#${invoice.jobNumber}` });
  return facts;
}

/** Who pays it: the billing name and address, unless Jobber says they are the property's. */
export function billTo(invoice: InvoiceDetail): string[] {
  const details = invoice.details;
  const lines = [details?.billingName || invoice.clientName];
  if (invoice.billingAddress && details?.billingSameAsProperty !== true) lines.push(invoice.billingAddress);
  return lines;
}

const place = (invoice: InvoiceDetail) =>
  invoice.property
    ? [invoice.property.address, invoice.property.city].filter(Boolean).join(', ')
    : (invoice.details?.propertyAddress ?? null);

const quantity = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, ''));

export function InvoiceDocument({ invoice, brand }: { invoice: InvoiceDetail; brand: ReceiptBrand }) {
  return (
    <Document author={brand.name} creator={brand.name} producer={brand.name} title={invoiceDocumentName(invoice)}>
      <InvoicePages brand={brand} invoice={invoice} />
    </Document>
  );
}

/**
 * Many invoices in one file to print and mail (2026-11-09, Batch Deliver),
 * each starting on a page of its own and numbered on its own: "Page 2 of 3"
 * is that invoice's second page, not the file's.
 */
export function InvoicesDocument({
  invoices,
  brand,
}: {
  invoices: readonly { invoice: InvoiceDetail; brand: ReceiptBrand }[];
  brand: ReceiptBrand;
}) {
  return (
    <Document author={brand.name} creator={brand.name} producer={brand.name} title={`${invoices.length} invoices`}>
      {invoices.map((one) => (
        <InvoicePages brand={one.brand} invoice={one.invoice} key={one.invoice.id} />
      ))}
    </Document>
  );
}

/** One invoice: a single `Page` that runs onto as many pages as its lines need. */
function InvoicePages({ invoice, brand }: { invoice: InvoiceDetail; brand: ReceiptBrand }) {
  const name = invoiceDocumentName(invoice);
  const totals = invoiceTotalLines(invoice);
  const due = totals[totals.length - 1]!;
  const where = place(invoice);
  return (
    <>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>{brand.name}</Text>
            {[brand.addressLine1, brand.addressLine2, brand.phone, brand.email]
              .filter((line): line is string => Boolean(line))
              .map((line) => (
                <Text key={line} style={styles.muted}>
                  {line}
                </Text>
              ))}
          </View>
          <View>
            <Text style={styles.title}>Invoice</Text>
            <Text style={styles.subtitle}>{invoice.number ? `#${invoice.number}` : invoice.subject}</Text>
          </View>
        </View>

        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.sectionTitle}>Bill to</Text>
            {billTo(invoice).map((line, index) => (
              <Text key={`${index}:${line}`} style={index === 0 ? styles.strong : styles.muted}>
                {line}
              </Text>
            ))}
            {where && where !== invoice.clientName ? (
              <>
                <Text style={[styles.sectionTitle, { marginTop: 10 }]}>Property</Text>
                <Text>{where}</Text>
              </>
            ) : null}
          </View>
          <View style={styles.party}>
            <Text style={styles.sectionTitle}>{invoice.subject}</Text>
            {invoiceFacts(invoice).map((fact) => (
              <View key={fact.label} style={styles.fact}>
                <Text style={{ color: C.muted }}>{fact.label}</Text>
                <Text>{fact.value}</Text>
              </View>
            ))}
            <View style={styles.fact}>
              <Text style={styles.strong}>Balance due</Text>
              <Text style={styles.strong}>{due.value}</Text>
            </View>
          </View>
        </View>

        <View fixed style={styles.tableHead}>
          <Text style={[styles.service, styles.head]}>Product / Service</Text>
          <Text style={[styles.qty, styles.head]}>Qty</Text>
          <Text style={[styles.money, styles.head]}>Unit price</Text>
          <Text style={[styles.money, styles.head]}>Total</Text>
        </View>
        {invoice.lineItems.map((line, index) => (
          <View key={`${index}:${line.name}`} style={styles.row} wrap={false}>
            <View style={styles.service}>
              <Text style={styles.strong}>{line.name}</Text>
              {line.description ? <Text style={styles.muted}>{line.description}</Text> : null}
              {line.serviceOn ? <Text style={styles.muted}>Done {invoiceDay(line.serviceOn)}</Text> : null}
            </View>
            <Text style={styles.qty}>{quantity(line.quantity)}</Text>
            <Text style={styles.money}>{formatMoney(line.unitPriceCents)}</Text>
            <Text style={styles.money}>{formatMoney(line.totalCents)}</Text>
          </View>
        ))}

        <View style={styles.totals} wrap={false}>
          {totals.slice(0, -1).map((line) => (
            <View key={line.label} style={styles.totalLine}>
              <Text style={{ color: C.muted }}>{line.label}</Text>
              <Text>{line.value}</Text>
            </View>
          ))}
          <View style={styles.due}>
            <Text style={styles.dueText}>{due.label}</Text>
            <Text style={styles.dueText}>{due.value}</Text>
          </View>
        </View>

        {invoice.clientMessage ? (
          <View style={styles.note} wrap={false}>
            <Text>{invoice.clientMessage}</Text>
          </View>
        ) : null}
        {invoice.details?.contractDisclaimer ? (
          <View style={styles.note}>
            <Text style={{ color: C.muted, fontSize: 9 }}>{invoice.details.contractDisclaimer}</Text>
          </View>
        ) : null}

        <View fixed style={styles.footer}>
          <Text>
            {brand.name} · {name}
          </Text>
          <Text
            render={({ subPageNumber, subPageTotalPages }) =>
              subPageTotalPages > 1 ? `Page ${subPageNumber} of ${subPageTotalPages}` : ''
            }
          />
        </View>
      </Page>
    </>
  );
}
