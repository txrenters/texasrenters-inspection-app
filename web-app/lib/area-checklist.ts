import { api } from './api';

export interface AreaChecklistItem {
  id: string;
  label: string;
  keywords: string[];
  sortOrder: number;
}

export function fetchAreaChecklist(areaId: string, signal?: AbortSignal) {
  return api<AreaChecklistItem[]>(`/api/v1/admin/property-areas/${areaId}/checklist`, { signal });
}

export function createChecklistItem(
  areaId: string,
  input: { label: string; keywords: string[] },
) {
  return api<AreaChecklistItem>(`/api/v1/admin/property-areas/${areaId}/checklist`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateChecklistItem(
  itemId: string,
  input: { label?: string; keywords?: string[]; sortOrder?: number },
) {
  return api<AreaChecklistItem>(`/api/v1/admin/checklist-items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/** Archives rather than deletes — coverage already recorded must still resolve. */
export function archiveChecklistItem(itemId: string) {
  return api<{ id: string; archived: boolean }>(`/api/v1/admin/checklist-items/${itemId}`, {
    method: 'DELETE',
  });
}

/**
 * Splits an administrator's comma-separated input into keywords.
 *
 * The server lowercases and de-duplicates too; doing it here as well means the
 * field shows what will actually be saved rather than what was typed.
 */
export function parseKeywords(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((word) => word.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
