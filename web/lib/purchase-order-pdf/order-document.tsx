import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { REPORT_PALETTE, formatMoney, formatTaxRate, type PurchaseOrderDetail } from '@texasrenters/shared';

/**
 * A purchase order as a PDF (2026-11-19, phase 3): who it is from, the vendor
 * it goes to, its number and days, each line at the price agreed, and the
 * total with sales tax. No images, so it renders in the browser from what the
 * order's page already holds -- nothing is asked of the server and nothing
 * billed is called to make it.
 *
 * Laid out as the invoice is: a line is never split across two pages and the
 * table's heading repeats.
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
  code: { width: '18%', paddingRight: 6 },
  item: { width: '40%', paddingRight: 8 },
  qty: { width: '12%', textAlign: 'right' },
  money: { width: '15%', textAlign: 'right' },
  head: { fontSize: 8, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
  totals: { marginLeft: 'auto', width: '45%', paddingTop: 10 },
  totalLine: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  total: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: C.text, marginTop: 4, paddingTop: 6 },
  totalText: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: C.brandDark },
  note: { paddingTop: 18 },
  footer: { position: 'absolute', bottom: 28, left: 48, right: 48, color: C.muted, fontSize: 8, flexDirection: 'row', justifyContent: 'space-between' },
});

/** "Nov 24, 2026": a day, never a moment. */
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
export const orderDay = (day: string | null) => (day ? DAY.format(new Date(`${day.slice(0, 10)}T12:00:00.000Z`)) : '—');

/** The days and terms printed beside the vendor; empty ones left out. */
export function orderFacts(order: PurchaseOrderDetail): { label: string; value: string }[] {
  const facts = [{ label: 'Ordered', value: orderDay(order.approvedAt ?? order.createdAt) }];
  if (order.expectedOn) facts.push({ label: 'Expected by', value: orderDay(order.expectedOn) });
  if (order.terms) facts.push({ label: 'Terms', value: order.terms });
  if (order.deliverTo) facts.push({ label: 'Deliver to', value: order.deliverTo.name });
  if (order.requisition.number) facts.push({ label: 'Requisition', value: order.requisition.number });
  return facts;
}

/** What the vendor is told about itself: its name and whoever the office deals with there. */
export function orderVendorLines(order: PurchaseOrderDetail): string[] {
  const contact = order.vendorContact;
  return [order.vendor?.name ?? 'No vendor chosen', contact?.contactName, contact?.email, contact?.phone].filter((line): line is string => Boolean(line));
}

export function PurchaseOrderDocument({ order }: { order: PurchaseOrderDetail }) {
  const from = order.from;
  const title = order.number ? `Purchase order ${order.number}` : 'Purchase order, draft';
  return (
    <Document author={from.name} title={title}>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>{from.name}</Text>
            {[from.addressLine1, from.addressLine2, from.phone, from.email].filter(Boolean).map((line) => (
              <Text key={line} style={styles.muted}>
                {line}
              </Text>
            ))}
          </View>
          <View>
            <Text style={styles.title}>Purchase order</Text>
            <Text style={styles.subtitle}>{order.number ?? 'Draft'}</Text>
          </View>
        </View>

        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.sectionTitle}>To</Text>
            {orderVendorLines(order).map((line, index) => (
              <Text key={line} style={index ? styles.muted : styles.strong}>
                {line}
              </Text>
            ))}
          </View>
          <View style={styles.party}>
            {orderFacts(order).map((fact) => (
              <View key={fact.label} style={styles.fact}>
                <Text style={{ color: C.muted }}>{fact.label}</Text>
                <Text>{fact.value}</Text>
              </View>
            ))}
          </View>
        </View>

        <View fixed style={styles.tableHead}>
          <Text style={[styles.code, styles.head]}>Code</Text>
          <Text style={[styles.item, styles.head]}>Item</Text>
          <Text style={[styles.qty, styles.head]}>Qty</Text>
          <Text style={[styles.money, styles.head]}>Each</Text>
          <Text style={[styles.money, styles.head]}>Total</Text>
        </View>
        {order.lines.map((line) => (
          <View key={line.id} style={styles.row} wrap={false}>
            <Text style={styles.code}>{line.item.code}</Text>
            <Text style={styles.item}>
              {line.item.name}
              {line.item.unit === 'each' ? '' : ` (${line.item.unit})`}
            </Text>
            <Text style={styles.qty}>{line.quantity}</Text>
            <Text style={styles.money}>{formatMoney(line.unitPriceCents)}</Text>
            <Text style={styles.money}>{formatMoney(line.quantity * line.unitPriceCents)}</Text>
          </View>
        ))}

        <View style={styles.totals} wrap={false}>
          <View style={styles.totalLine}>
            <Text>Subtotal</Text>
            <Text>{formatMoney(order.subtotalCents)}</Text>
          </View>
          {order.taxBasisPoints ? (
            <View style={styles.totalLine}>
              <Text>Sales tax, {formatTaxRate(order.taxBasisPoints)}</Text>
              <Text>{formatMoney(order.taxCents)}</Text>
            </View>
          ) : null}
          <View style={styles.total}>
            <Text style={styles.totalText}>Order total</Text>
            <Text style={styles.totalText}>{formatMoney(order.totalCents)}</Text>
          </View>
        </View>

        {order.notes ? (
          <View style={styles.note}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text>{order.notes}</Text>
          </View>
        ) : null}

        <View fixed style={styles.footer}>
          <Text>{title}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
