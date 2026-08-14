import { useMemo } from 'react';

import type { AreaEnvironment } from '../domain/models';
import { useRoomChecklist } from '../features/queries';
import { resolveAreaChecklist, type ChecklistItem } from './area-checklist';

/**
 * The coverage checklist for one area: what an administrator authored for it,
 * or a generated list when nobody has configured it yet.
 *
 * One hook because the answer has to be the same everywhere. The camera fetched
 * the authored list while the area screen generated its own, so the two screens
 * showed different items — and worse, the auto-tick from the AI summary ran
 * against the generated ids, recording coverage against items the technician
 * was never shown. Anything that needs this list takes it from here.
 */
export function useAreaChecklist(
  roomId: string,
  area: {
    name?: string | null;
    environment?: AreaEnvironment;
    category?: string | null;
    inspectionType?: string | null;
  },
): ChecklistItem[] {
  const authored = useRoomChecklist(roomId);
  const name = area.name ?? '';
  const environment = area.environment;
  const category = area.category ?? null;
  const inspectionType = area.inspectionType ?? null;
  return useMemo(
    () => resolveAreaChecklist(authored.data, { name, environment, category, inspectionType }),
    [authored.data, name, environment, category, inspectionType],
  );
}
