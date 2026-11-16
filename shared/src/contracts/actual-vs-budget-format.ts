/**
 * Actual vs Budget's cells as the office's workbook writes them (2026-11-17):
 * 11/11/2026, 5:36 PM, 78.99, $400, ($75.35), 3,550.00. Shared since the
 * console started writing the same cells into the workbook itself, so the page
 * and the workbook always show a figure the same way.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** m/d/yyyy. */
export const sheetDate = (day: string | null) => {
  if (!day || !DAY.test(day)) return day ?? '';
  const [year, month, date] = day.split('-');
  return `${Number(month)}/${Number(date)}/${year}`;
};

/** h:mm AM/PM. */
export const sheetTime = (clock: string | null) => {
  if (!clock) return '';
  const [hours, minutes] = clock.split(':').map(Number) as [number, number];
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
};

/** _(* #,##0.00_): two decimals, a dash for zero, nothing for empty. */
export const sheetMoney = (cents: number | null) => {
  if (cents === null) return '';
  if (cents === 0) return '-';
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** "$"#,##0: a day's revenue budget total in whole dollars. */
export const sheetWholeDollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

/**
 * Dollars as the daily sheets write them: "$400", "$347.98", and a negative as
 * "-$157.98" (the daily report) or "($75.35)" (the tracker, and every Total).
 */
export function dollars(cents: number, options: { decimals?: 0 | 2; negative?: 'minus' | 'brackets' } = {}): string {
  const decimals = options.decimals ?? 2;
  const amount = Math.abs(cents) / 100;
  const text = `$${amount.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  if (cents >= 0 || text === `$${(0).toFixed(decimals)}`) return text;
  return options.negative === 'brackets' ? `(${text})` : `-${text}`;
}

/** The weekly and monthly reports' _(* #,##0.00_): "3,550.00", "(1,191.86)", and "-" for nothing. */
export function accounting(cents: number): string {
  if (cents === 0) return '-';
  const text = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cents < 0 ? `(${text})` : text;
}

/** The first word of a name: the projection's "Amy", "Kevin". */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
