import type { MakePurchaseOrdersInput, PendingOrderLine } from '@texasrenters/shared';

/**
 * Pending Processing (the office, 2026-11-23), as NAV's requisition worksheet:
 * the approved requisition lines not ordered yet, by company and vendor. The
 * purchaser ticks lines, or a whole vendor, and each vendor and company gets
 * one order; the same item to the same place is one line, its quantities
 * added. A line with no vendor joins one once it is chosen. The server makes
 * the orders the same way; this only says beforehand what it will make.
 */

export type PendingVendor = NonNullable<PendingOrderLine['vendor']>;

/** The vendor a line goes to: the one chosen here, else its own. */
export function vendorOf(line: PendingOrderLine, chosen: ReadonlyMap<string, PendingVendor>): PendingOrderLine['vendor'] {
  return chosen.get(line.requisitionLineId) ?? line.vendor;
}

export const lineAmountCents = (line: Pick<PendingOrderLine, 'quantity' | 'estimatedUnitCostCents'>) => line.quantity * line.estimatedUnitCostCents;

const orderKey = (line: PendingOrderLine, vendor: PendingOrderLine['vendor']) => `${line.company?.tenantId ?? ''}|${vendor?.id ?? ''}`;
const mergeKey = (line: PendingOrderLine) => `${line.item.id}|${line.place?.id ?? ''}`;

export interface PendingGroup {
  key: string;
  company: PendingOrderLine['company'];
  /** Null: no vendor yet. */
  vendor: PendingOrderLine['vendor'];
  lines: PendingOrderLine[];
  requisitionCount: number;
  amountCents: number;
  /** The same vendor has lines for another company too: an order of its own. */
  otherCompany: boolean;
}

/** The lines by company and vendor, in the order they first come (oldest requisition first); the ones with no vendor last. */
export function pendingGroups(lines: readonly PendingOrderLine[], chosen: ReadonlyMap<string, PendingVendor>): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  for (const line of lines) {
    const vendor = vendorOf(line, chosen);
    const key = orderKey(line, vendor);
    const group = groups.get(key) ?? { key, company: line.company, vendor, lines: [], requisitionCount: 0, amountCents: 0, otherCompany: false };
    group.lines.push(line);
    group.amountCents += lineAmountCents(line);
    groups.set(key, group);
  }
  const all = [...groups.values()];
  for (const group of all) {
    group.requisitionCount = new Set(group.lines.map((line) => line.requisition.id)).size;
    group.otherCompany = Boolean(group.vendor) && all.some((other) => other !== group && other.vendor?.id === group.vendor?.id && other.company?.tenantId !== group.company?.tenantId);
  }
  return [...all.filter((group) => group.vendor), ...all.filter((group) => !group.vendor)];
}

export interface TickedSummary {
  lineCount: number;
  requisitionCount: number;
  amountCents: number;
  /** One a vendor and company, with how many lines it will have once the same item to the same place is one. */
  orders: { key: string; company: PendingOrderLine['company']; vendor: PendingVendor; lineCount: number }[];
  /** The lines that become one: the same item, to the same place, on the same order. */
  merges: { key: string; item: PendingOrderLine['item']; place: PendingOrderLine['place']; requisitions: string[]; quantity: number; lineIds: string[] }[];
}

/** What Make Purchase Orders will make of the lines ticked. A line with no vendor is never ticked. */
export function tickedSummary(lines: readonly PendingOrderLine[], chosen: ReadonlyMap<string, PendingVendor>, ticked: ReadonlySet<string>): TickedSummary {
  const picked = lines.filter((line) => ticked.has(line.requisitionLineId) && vendorOf(line, chosen));
  const orders = new Map<string, { key: string; company: PendingOrderLine['company']; vendor: PendingVendor; keys: Map<string, PendingOrderLine[]> }>();
  for (const line of picked) {
    const vendor = vendorOf(line, chosen)!;
    const key = orderKey(line, vendor);
    const order = orders.get(key) ?? { key, company: line.company, vendor, keys: new Map<string, PendingOrderLine[]>() };
    order.keys.set(mergeKey(line), [...(order.keys.get(mergeKey(line)) ?? []), line]);
    orders.set(key, order);
  }
  return {
    lineCount: picked.length,
    requisitionCount: new Set(picked.map((line) => line.requisition.id)).size,
    amountCents: picked.reduce((sum, line) => sum + lineAmountCents(line), 0),
    orders: [...orders.values()].map((order) => ({ key: order.key, company: order.company, vendor: order.vendor, lineCount: order.keys.size })),
    merges: [...orders.values()].flatMap((order) =>
      [...order.keys.entries()]
        .filter(([, same]) => same.length > 1)
        .map(([key, same]) => ({
          key: `${order.key}|${key}`,
          item: same[0]!.item,
          place: same[0]!.place,
          requisitions: [...new Set(same.map((line) => line.requisition.number ?? 'a requisition'))],
          quantity: same.reduce((sum, line) => sum + line.quantity, 0),
          lineIds: same.map((line) => line.requisitionLineId),
        })),
    ),
  };
}

/** The request Make Purchase Orders sends: each line ticked with the vendor it goes to. */
export function makeOrdersInput(lines: readonly PendingOrderLine[], chosen: ReadonlyMap<string, PendingVendor>, ticked: ReadonlySet<string>): MakePurchaseOrdersInput {
  return {
    lines: lines.flatMap((line) => {
      const vendor = vendorOf(line, chosen);
      return ticked.has(line.requisitionLineId) && vendor ? [{ requisitionLineId: line.requisitionLineId, vendorId: vendor.id }] : [];
    }),
  };
}

/** "PR-00012 and PR-00015", "PR-00012, PR-00015 and PR-00016". */
export function andList(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
