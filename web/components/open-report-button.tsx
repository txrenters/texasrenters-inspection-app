'use client';

import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useAdminMutations } from '@/lib/queries';

/**
 * The job's report, as a tenant or owner reads it, in a tab of its own. Until
 * now the only way to read it from the job was to create a share link.
 */
export function OpenReportButton({ inspectionId }: { inspectionId: string }) {
  const { openReport } = useAdminMutations();

  function open() {
    // Opened now, not on the answer: a tab opened later is no longer the click's
    // doing, and the browser blocks it as a popup.
    const tab = window.open('', '_blank');
    openReport.mutate(inspectionId, {
      onSuccess: ({ sharePath }) => {
        if (tab) tab.location.href = sharePath;
        else window.location.assign(sharePath);
      },
      onError: (error) => {
        tab?.close();
        toast.error('The report did not open', { description: error.message });
      },
    });
  }

  return (
    <Button disabled={openReport.isPending} onClick={open} variant="outline">
      Open report
    </Button>
  );
}
