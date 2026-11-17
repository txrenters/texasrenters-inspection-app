/**
 * Actual vs Budget kept in step with the office's own workbook (2026-11-17;
 * the office: "everything should sync on this spreadsheet also").
 */

export type MicrosoftConnectionStatus = 'CONNECTED' | 'REAUTHORIZATION_REQUIRED' | 'DISCONNECTED';

export interface ExcelSyncView {
  /** Whether this server has the Microsoft app's settings at all. */
  configured: boolean;
  /** The address Microsoft must have on the app as a redirect URI. */
  redirectUri: string | null;
  connection: {
    status: MicrosoftConnectionStatus;
    accountEmail: string | null;
    accountName: string | null;
    connectedAt: string | null;
    problem: string | null;
  } | null;
  workbook: {
    shareUrl: string;
    fileName: string;
    webUrl: string | null;
    enabled: boolean;
    /** The first day the console writes; the tabs before it are the office's own. */
    startDate: string;
    lastPushedAt: string | null;
    /** The last time the office's Excel edits were read, and what came of them; null before any was read. */
    lastPull: ExcelPull | null;
    /** A save the workbook has not had yet. */
    waiting: boolean;
    problem: string | null;
  } | null;
}

export interface SaveExcelSyncInput {
  shareUrl?: string;
  startDate?: string;
  enabled?: boolean;
}

/** What one write did; and, when the workbook had been edited since the last, what was read from it first. */
export interface ExcelSyncRun {
  tabs: { name: string; created: boolean; rowsWritten: number }[];
  calls: number;
  pulled: ExcelPull | null;
}

/**
 * Reading the office's Excel edits back (2026-11-18, "Both ways"): cells the
 * office types in on the page come into the console; cells the console works
 * out are put back; a cell changed in both places keeps the console's value.
 */
export interface ExcelPull {
  at: string;
  taken: number;
  putBack: number;
  conflicts: number;
}
