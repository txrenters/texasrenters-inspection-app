'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EmailTemplatesView, InvoiceDetail, SaveEmailTemplatesInput } from '@texasrenters/shared';

import { api } from './api';
import { invoiceKeys } from './invoice-queries';

/**
 * Notes and files written on an invoice in the console, and the office's email
 * words (2026-11-10, phase 4 of the invoice gap review). Writes of the
 * console's own database and storage; nothing billed is called. Each write
 * answers with the invoice as it now is.
 */

const INVOICES = '/api/v1/admin/invoices';
const TEMPLATES = '/api/v1/admin/invoice-settings/email-templates';

export const emailTemplatesKey = [...invoiceKeys.all, 'email-templates'] as const;

export function useInvoiceRecords(invoiceId: string) {
  const client = useQueryClient();
  const saved = (invoice: InvoiceDetail) => client.setQueryData(invoiceKeys.detail(invoice.id), invoice);
  const path = `${INVOICES}/${encodeURIComponent(invoiceId)}`;
  return {
    addNote: useMutation({
      mutationFn: (message: string) => api<InvoiceDetail>(`${path}/notes`, { method: 'POST', body: JSON.stringify({ message }) }),
      onSuccess: saved,
    }),
    removeNote: useMutation({
      mutationFn: (noteId: string) => api<InvoiceDetail>(`${path}/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' }),
      onSuccess: saved,
    }),
    addFile: useMutation({
      mutationFn: (file: File) => {
        const form = new FormData();
        form.append('file', file);
        return api<InvoiceDetail>(`${path}/files`, { method: 'POST', body: form });
      },
      onSuccess: saved,
    }),
    removeFile: useMutation({
      mutationFn: (fileId: string) => api<InvoiceDetail>(`${path}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }),
      onSuccess: saved,
    }),
  };
}

export function useEmailTemplates(enabled = true) {
  return useQuery({
    queryKey: emailTemplatesKey,
    queryFn: ({ signal }) => api<EmailTemplatesView>(TEMPLATES, { signal }),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSaveEmailTemplates() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveEmailTemplatesInput) => api<EmailTemplatesView>(TEMPLATES, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (view) => client.setQueryData(emailTemplatesKey, view),
    onError: () => void client.invalidateQueries({ queryKey: emailTemplatesKey }),
  });
}
