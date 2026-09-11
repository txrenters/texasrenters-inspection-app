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
 * The two questions an occupied visit asks, in place of the room checklist.
 *
 * Read-only, and not addressed by area: these are held once for the
 * organization with a null area, because "Room condition" is the same question
 * in a kitchen and in a hallway. Fetched alongside the per-area list so the
 * dialog can show which visit reads which, rather than presenting the room
 * checklist as though it were the only one.
 */
export interface OccupiedChecklistItem {
  id: string;
  label: string;
  responseType: string;
  choices: string[];
  sortOrder: number;
}

export function fetchOccupiedChecklist(signal?: AbortSignal) {
  return api<OccupiedChecklistItem[]>('/api/v1/admin/checklists/occupied', { signal });
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

