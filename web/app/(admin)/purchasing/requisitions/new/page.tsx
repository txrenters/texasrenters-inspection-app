'use client';

import { useRouter, useSearchParams } from 'next/navigation';

import { PurchasingTabs } from '@/components/purchasing/purchasing-tabs';
import { RequisitionForm } from '@/components/purchasing/requisition-form';
import { ErrorState, PageSkeleton } from '@/components/states';
import { usePermissions } from '@/lib/auth';
import { usePurchasingEdits, useRequisitionChoices } from '@/lib/purchasing-queries';

/**
 * A new purchase requisition (2026-11-19, phase 2; laid out as the canvas's NAV
 * page 2026-11-20). It gets its number when it is first saved, as a draft that
 * is its author's alone; submitted, it goes to the approvers. Either way the
 * page then moves to the requisition itself.
 */
export default function NewRequisitionPage() {
  const router = useRouter();
  // "?items=<item>:<quantity>,...": what the Reorder list ticked. Read once, as the form's starting lines.
  const asked = useSearchParams().get('items') ?? '';
  const start = asked
    .split(',')
    .map((pair) => pair.split(':'))
    .flatMap(([itemId, quantity]) => (itemId && /^\d{1,6}$/.test(quantity ?? '') && Number(quantity) > 0 ? [{ itemId, quantity: Number(quantity) }] : []));
  const choices = useRequisitionChoices(true);
  const { create, step } = usePurchasingEdits();
  const { permissions } = usePermissions();

  if (choices.isLoading) return <PageSkeleton />;
  if (choices.isError || !choices.data) return <ErrorState error={choices.error} retry={() => void choices.refetch()} />;

  return (
    <>
      <PurchasingTabs current="requisitions" />
      <RequisitionForm
        choices={choices.data}
        error={create.error ?? step.error}
        onDiscard={() => router.push('/purchasing')}
        permissions={permissions}
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
        start={start}
      />
    </>
  );
}
