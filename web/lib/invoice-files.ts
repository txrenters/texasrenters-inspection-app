'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InvoiceFileCopyStatus, InvoiceFileLink, InvoiceSettingsView } from '@texasrenters/shared';

import { api } from './api';
import { invoiceSettingsKey } from './invoice-settings-queries';

/**
 * The files on Jobber's invoices (2026-11-06, phase 7 of taking invoicing over
 * from Jobber): opened through a short-lived link to the console's own copy,
 * or to Jobber's until it is kept; and trying again the copies that failed.
 */

/**
 * Opens one file in a new tab. The tab is opened on the click, before the link
 * is asked for, so the browser does not take it for a pop-up; it is closed
 * again if no link comes back.
 */
export async function openInvoiceFile(invoiceId: string, fileId: string): Promise<'opened' | 'blocked'> {
  const tab = window.open('', '_blank');
  try {
    const link = await api<InvoiceFileLink>(
      `/api/v1/admin/invoices/${encodeURIComponent(invoiceId)}/files/${encodeURIComponent(fileId)}/link`,
    );
    if (!tab) return 'blocked';
    // Jobber's or the storage's address: neither needs to know the console's page.
    tab.opener = null;
    tab.location.href = link.url;
    return 'opened';
  } catch (error) {
    tab?.close();
    throw error;
  }
}

export function useRetryFileCopies() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<InvoiceFileCopyStatus>('/api/v1/admin/invoice-settings/file-copies/retry', { method: 'POST' }),
    onSuccess: (files) =>
      client.setQueryData<InvoiceSettingsView>(invoiceSettingsKey, (settings) => (settings ? { ...settings, files } : settings)),
  });
}
