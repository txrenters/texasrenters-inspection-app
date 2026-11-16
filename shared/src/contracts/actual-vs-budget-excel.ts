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

/** What one write did. */
export interface ExcelSyncRun {
  tabs: { name: string; created: boolean; rowsWritten: number }[];
  calls: number;
}
