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

/**
 * Keywords are optional: omit them and the server derives what to listen for
 * from the label, which is all the authoring UI asks an administrator to write.
 */
export function createChecklistItem(
  areaId: string,
  input: { label: string; keywords?: string[] },
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

