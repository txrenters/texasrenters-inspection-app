import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatTaxRate, type PurchaseOrderDetail } from '@texasrenters/shared';

import { coded, fromLines, navAmount, navDay, navMoment, navMomentDay, navStyles as styles } from '../nav-pdf/nav-pdf';

/**
 * A purchase order as a PDF (2026-11-19, phase 3), laid out as the approved
 * PoPdf board since 2026-11-20 (part 4): a portrait page in black on white, as
 * NAV prints one. The company and "Purchase Order" with its number; the
 * Buy-from Vendor and Ship-to boxes side by side; the order's facts in two
 * columns; each line at the price agreed; the totals with sales tax; the notes
 * to the vendor; and the boxes for who approved it and for the vendor to sign.
 *
 * No images, so it renders in the browser from what the order's page already
 * holds -- nothing is asked of the server and nothing billed is called to make
 * it. A line is never split across two pages, and the table's heading repeats.
 *
 * The vendor has no address on file, so its box names it and whoever the
 * office deals with there.
 */

const own = StyleSheet.create({
  boxes: { flexDirection: 'row', marginBottom: 13 },
  fact: { width: '50%' },
  notes: { marginTop: 13 },
});

/** The lines' columns, as the board draws them. */
// Each line's Location Code (2026-11-23): one order may go to several places.
const COLUMNS = [
  { label: 'Item Code', width: '12%' },
  { label: 'Description', width: '24%' },
  { label: 'Location Code', width: '10%' },
  { label: 'Quantity', width: '8%', right: true },
  { label: 'UoM', width: '6%' },
  { label: 'Direct Unit Cost', width: '12%', right: true },
  { label: 'Line Amount', width: '12%', right: true },
  { label: 'Expected Receipt', width: '16%' },
] as const;

/** The day it was ordered: when it was approved, else when it was made. */
export const orderDay = (order: Pick<PurchaseOrderDetail, 'approvedAt' | 'createdAt'>) => navMomentDay(order.approvedAt ?? order.createdAt);

/** Its lines go to more than one place (2026-11-23): each line says where. */
const severalPlaces = (order: Pick<PurchaseOrderDetail, 'lines'>) => new Set(order.lines.map((line) => line.place?.id ?? '')).size > 1;

/** The facts under the two boxes, read across two columns as the board lays them out. */
export function orderFacts(order: PurchaseOrderDetail): { label: string; value: string }[] {
  return [
    { label: 'Order Date', value: orderDay(order) },
    { label: 'Vendor No.', value: order.vendor?.number ?? '' },
    { label: 'Expected Receipt', value: navDay(order.expectedOn) },
    { label: 'Purchaser Code', value: order.company?.purchaserCode ?? '' },
    { label: 'Payment Terms', value: order.terms ?? '' },
    { label: 'Location Code', value: severalPlaces(order) ? 'Each line' : (order.deliverTo?.code ?? '') },
    { label: 'Requisition No.', value: (order.requisitions?.length ? order.requisitions : [order.requisition]).map((one) => one.number ?? '').filter(Boolean).join(', ') },
    { label: 'Ordered by', value: order.madeBy.name },
  ];
}

/** The Buy-from Vendor box: the vendor by number and name, whoever the office deals with there, and how to reach them. */
export function orderVendorLines(order: PurchaseOrderDetail): string[] {
  const contact = order.vendorContact;
  const vendor = order.vendor ? coded({ code: order.vendor.number, name: order.vendor.name }) : 'No vendor chosen';
  const reach = [contact?.email, contact?.phone].filter(Boolean).join(' · ');
  return [vendor, contact?.contactName ? `Attn: ${contact.contactName}` : '', reach].filter(Boolean);
}

/** The Ship-to box: the place by code and name, at the office, for the company the order is for. */
export function orderShipToLines(order: PurchaseOrderDetail): string[] {
  const { address } = fromLines(order.from);
  const where = severalPlaces(order) ? "Each line's Location Code" : order.deliverTo ? coded(order.deliverTo) : 'The office';
  return [where, order.company?.name ?? order.from.name, address, order.from.phone ? `Receiving: ${order.from.phone}` : ''].filter(Boolean);
}

export function PurchaseOrderDocument({ order }: { order: PurchaseOrderDetail }) {
  const from = order.from;
  const { address, contact } = fromLines(from);
  const number = order.number ?? 'Draft';
  const boxed = (heading: string, lines: string[]) => (
    <>
      <Text style={styles.boxHead}>{heading}</Text>
      {lines.map((line, index) => (
        <Text key={`${index}-${line}`} style={index ? {} : styles.bold}>
          {line}
        </Text>
      ))}
    </>
  );

  return (
    <Document author={from.name} title={order.number ? `Purchase order ${order.number}` : 'Purchase order, draft'}>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.top}>
          <View>
            <Text style={styles.company}>{from.name}</Text>
            {address ? <Text style={styles.fromLine}>{address}</Text> : null}
            {contact ? <Text style={styles.fromLine}>{contact}</Text> : null}
          </View>
          <View style={styles.titleBox}>
            <Text style={styles.title}>Purchase Order</Text>
            <Text style={styles.number}>{number}</Text>
            <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} style={styles.muted} />
          </View>
        </View>
        <View style={styles.rule} />

        <View style={own.boxes}>
          <View style={[styles.box, { flex: 1 }]}>{boxed('Buy-from Vendor', orderVendorLines(order))}</View>
          <View style={[styles.box, styles.signGap, { flex: 1 }]}>{boxed('Ship-to', orderShipToLines(order))}</View>
        </View>

        <View style={styles.facts}>
          {orderFacts(order).map((fact) => (
            <View key={fact.label} style={[styles.fact, own.fact]}>
              <Text style={styles.factLabel}>{fact.label}</Text>
              <Text style={styles.factValue}>{fact.value}</Text>
            </View>
          ))}
        </View>

        <View fixed style={styles.head}>
          {COLUMNS.map((column) => (
            <Text key={column.label} style={[styles.th, { width: column.width }, 'right' in column ? styles.right : {}]}>
              {column.label}
            </Text>
          ))}
        </View>
        {order.lines.map((line) => (
          <View key={line.id} style={styles.row} wrap={false}>
            {[line.item.code, line.item.name, line.place?.code ?? line.place?.name ?? '', String(line.quantity), line.item.unit.toUpperCase(), navAmount(line.unitPriceCents), navAmount(line.quantity * line.unitPriceCents), navDay(order.expectedOn)].map((cell, index) => {
              const column = COLUMNS[index]!;
              return (
                <Text key={column.label} style={[styles.td, { width: column.width }, 'right' in column ? styles.right : {}]}>
                  {cell}
                </Text>
              );
            })}
          </View>
        ))}

        <View style={styles.totals} wrap={false}>
          <View style={styles.total}>
            <Text>Total Excl. Tax (USD)</Text>
            <Text style={styles.bold}>{navAmount(order.subtotalCents)}</Text>
          </View>
          <View style={styles.total}>
            <Text>Sales Tax {formatTaxRate(order.taxBasisPoints)} (USD)</Text>
            <Text style={styles.bold}>{navAmount(order.taxCents)}</Text>
          </View>
          <View style={[styles.total, styles.grand]}>
            <Text style={styles.bold}>Total Incl. Tax (USD)</Text>
            <Text style={styles.bold}>{navAmount(order.totalCents)}</Text>
          </View>
        </View>

        {order.notes ? (
          <View style={[styles.box, own.notes]} wrap={false}>
            <Text style={styles.boxHead}>Notes to the vendor</Text>
            <Text>{order.notes}</Text>
          </View>
        ) : null}

        <View style={styles.signs} wrap={false}>
          <View style={styles.sign}>
            <View style={styles.signText}>
              <Text style={styles.boxHead}>Approved by</Text>
              {order.approvedBy ? (
                <>
                  <Text>{order.approvedBy}</Text>
                  {order.approvedAt ? <Text style={styles.muted}>{navMoment(order.approvedAt)}</Text> : null}
                </>
              ) : (
                <Text style={styles.muted}>Not approved yet</Text>
              )}
            </View>
            <Text style={styles.signLine}>Signature</Text>
          </View>
          <View style={[styles.sign, styles.signGap]}>
            <View style={styles.signText}>
              <Text style={styles.boxHead}>Vendor acknowledgement</Text>
              <Text style={styles.muted}>Confirm the quantities, prices and date.</Text>
            </View>
            <Text style={styles.signLine}>Name, signature and date</Text>
          </View>
        </View>

        <View fixed style={styles.footer}>
          <Text>
            {from.name} · {number}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
