'use client';

import { useRouter } from 'next/navigation';

import { PageHeader } from '@/components/page-header';
import { RequisitionForm } from '@/components/purchasing/requisition-form';
import { RequisitionSteps } from '@/components/purchasing/requisition-parts';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { usePurchasingEdits, useRequisitionChoices } from '@/lib/purchasing-queries';

/**
 * A new purchase requisition (2026-11-19, phase 2). Saved as a draft it is its
 * author's alone; submitted, it takes its number and goes to the approvers.
 * Either way the page then moves to the requisition itself.
 */
export default function NewRequisitionPage() {
  const router = useRouter();
  const choices = useRequisitionChoices(true);
  const { create, step } = usePurchasingEdits();

  if (choices.isLoading) return <PageSkeleton />;
  if (choices.isError || !choices.data) return <ErrorState error={choices.error} retry={() => void choices.refetch()} />;

  return (
    <>
      <PageHeader
        badges={<Badge variant="secondary">Draft</Badge>}
        className="mb-3"
        description="It gets its number when you submit it."
        prominent
        title="New purchase requisition"
      />
      <div className="mb-6">
        <RequisitionSteps status="DRAFT" />
      </div>
      <RequisitionForm
        choices={choices.data}
        discardLabel="Discard"
        error={create.error ?? step.error}
        onDiscard={() => router.push('/purchasing')}
        onSave={async (input, submit) => {
          // Made once: if submitting is refused, the draft is kept and opened, where the reason shows.
          const made = create.data ?? (await create.mutateAsync(input));
          try {
            if (submit) await step.mutateAsync({ requisitionId: made.id, step: 'submit' });
          } finally {
            router.replace(`/purchasing/requisitions/${made.id}`);
          }
        }}
        pending={create.isPending || step.isPending}
      />
    </>
  );
}
