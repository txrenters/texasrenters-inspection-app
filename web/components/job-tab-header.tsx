import { visitStateOf, type AdminInspection } from '@texasrenters/shared';
import { ClipboardCheckIcon } from 'lucide-react';

import { JobHeadline } from '@/components/job-headline';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { typeTitle, typeTone } from '@/lib/inspection-type-tone';

/**
 * The job's header on its other tabs: the comparison and the summaries.
 *
 * They used to be titled for themselves ("Move-in vs move-out") with the
 * property in a small line beneath, so moving between the tabs of one job
 * changed its name. The title is the property on every tab now, and leads back
 * to the job; the tab bar under it says which part is open.
 */
export function JobTabHeader({ item }: { item: AdminInspection }) {
  return (
    <PageHeader
      badges={<StatusBadge value={visitStateOf(item)} />}
      description={<JobHeadline item={item} />}
      prominent
      record={{
        icon: ClipboardCheckIcon,
        tone: typeTone(item.inspectionType).text,
        label: `${typeTitle(item.inspectionType)} inspection`,
      }}
      title={item.propertywareBuilding?.name ?? 'Inspection'}
      titleHref={`/inspections/${item.id}`}
    />
  );
}
