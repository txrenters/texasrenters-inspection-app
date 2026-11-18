import type { StockStatus } from './inventory.js';

/**
 * Reorder and usage (2026-11-19, phase 7 of the inventory and purchasing
 * plan): what has reached its reorder level, with what is already on order
 * and how long it will last; and what the materials came to over a period,
 * by technician and by kind of job. Read-only, added up from the ledger and
 * the slips: nothing here is typed, and nothing calls anything billed.
 */

export const USAGE_PERIODS = ['30d', 'quarter', 'year'] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
export const USAGE_PERIOD_LABEL: Record<UsagePeriod, string> = { '30d': 'Last 30 days', quarter: 'This quarter', year: 'This year' };

/** The first Texas day of the period that `today` is in, and how many days of it have gone by, today included. */
export function usagePeriodSpan(period: UsagePeriod, today: string): { from: string; days: number } {
  const at = Date.parse(`${today}T00:00:00.000Z`);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  if (period === '30d') return { from: day(at - 29 * 86_400_000), days: 30 };
  const year = Number(today.slice(0, 4));
  const month = period === 'year' ? 0 : Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3;
  const start = Date.UTC(year, month, 1);
  return { from: day(start), days: Math.round((at - start) / 86_400_000) + 1 };
}

/** How many days what is on hand will last at the rate it was used; null when none was used, so nobody can say. */
export function daysOfStock(onHand: number, used: number, days: number): number | null {
  if (used <= 0 || days <= 0) return null;
  return Math.max(0, Math.floor(onHand / (used / days)));
}

/** What to ask for: the usual order quantity, or else enough to get back above the reorder level. */
export function suggestedOrder(item: { onHand: number; reorderLevel: number; reorderQuantity: number }): number {
  return item.reorderQuantity > 0 ? item.reorderQuantity : Math.max(1, item.reorderLevel - item.onHand + 1);
}

export interface ReorderRow {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  company: { tenantId: string; name: string } | null;
  status: StockStatus;
  onHand: number;
  reorderLevel: number;
  /** Ordered from a vendor and not yet received. */
  onOrder: number;
  /** Taken out less brought back, over the period. */
  used: number;
  lastsDays: number | null;
  suggested: number;
  usualVendor: { id: string; name: string } | null;
}

export interface UsageByTechnician {
  technicianId: string;
  name: string;
  /** What they took, less what they brought back, at cost. */
  valueCents: number;
  slips: number;
}

export interface UsageByJob {
  /** The kind of visit, in words; null for materials no visit was named for. */
  job: string | null;
  visits: number;
  valueCents: number;
}

export interface InventoryMonitoring {
  period: UsagePeriod;
  /** The first Texas day counted, and today. */
  from: string;
  to: string;
  /** Taken out less brought back, at cost. */
  usedCents: number;
  /** Received from vendors, at the orders' prices. */
  boughtCents: number;
  /** What the counts found missing less what they found extra, at cost; negative when more was found than lost. */
  lostInCountsCents: number;
  reorder: ReorderRow[];
  byTechnician: UsageByTechnician[];
  byJob: UsageByJob[];
}
