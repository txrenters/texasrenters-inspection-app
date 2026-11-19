'use client';

import { useParams, useRouter } from 'next/navigation';

import { PurchasingTabs } from '@/components/purchasing/purchasing-tabs';
import { RequisitionForm } from '@/components/purchasing/requisition-form';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { usePurchaseOrderEdits, usePurchasingEdits, useRequisition, useRequisitionChoices, type RequisitionStep } from '@/lib/purchasing-queries';

/**
 * One purchase requisition (2026-11-19, phase 2), as one NAV page (2026-11-20,
 * finished to the canvas): its author changes it while it is a draft or sent
 * back; everybody else, and its author once it is sent, reads the same page
 * with the ribbon's decisions open to whoever may take them. Every button is
 * drawn from what the server says this person may do.
 */
export default function RequisitionPage() {
  const { requisitionId } = useParams<{ requisitionId: string }>();
  const router = useRouter();
  const requisition = useRequisition(requisitionId);
  // Read either way: the FactBoxes show each line's item and stock whether it is being changed or read.
  const choices = useRequisitionChoices(Boolean(requisition.data));
  const edits = usePurchasingEdits();
  const orders = usePurchaseOrderEdits();

  if (requisition.isLoading || (requisition.data && choices.isLoading)) return <PageSkeleton />;
  if (requisition.isError || !requisition.data) return <ErrorState error={requisition.error} retry={() => void requisition.refetch()} />;
  if (choices.isError || !choices.data) return <ErrorState error={choices.error} retry={() => void choices.refetch()} />;

  const data = requisition.data;
  const editing = data.can.edit;
  const act = (step: RequisitionStep, note?: string) => edits.step.mutateAsync({ requisitionId, step, input: note ? { note } : {} });
  // Makes the draft order and opens it: the purchaser carries on there.
  const makeOrder = () =>
    void orders.create
      .mutateAsync(data.id)
      .then((order) => router.push(`/purchasing/orders/${order.id}`))
      .catch(() => undefined);

  return (
    <>
      <PurchasingTabs current="requisitions" />

      {data.status === 'SENT_BACK' || data.status === 'REJECTED' ? (
        <Alert className="mb-3" variant={data.status === 'REJECTED' ? 'destructive' : 'warning'}>
          <AlertDescription>
            {data.status === 'REJECTED'
              ? `${data.decidedBy ?? 'The approver'} rejected it: “${data.decisionNote ?? ''}”`
              : data.decidedBy
                ? `${data.decidedBy} sent it back: “${data.decisionNote ?? ''}”`
                : // Reopened (2026-11-20): nobody decided it; the note says so.
                  `${data.decisionNote ?? 'Reopened'}. Change it and send it for approval again.`}
          </AlertDescription>
        </Alert>
      ) : null}

      <RequisitionForm
        choices={choices.data}
        decisions={{ step: act, makeOrder, ordering: orders.create.isPending, error: orders.create.error ?? edits.step.error }}
        error={edits.update.error ?? edits.step.error}
        // A new page when it changes between being read and being changed: Reopen, Cancel Approval Request.
        key={`${data.id}-${editing ? 'edit' : 'read'}`}
        onDiscard={() => void act('cancel').catch(() => undefined)}
        onSave={async (input, submit) => {
          await edits.update.mutateAsync({ requisitionId, input });
          if (submit) await act('submit');
        }}
        pending={edits.update.isPending || edits.step.isPending}
        readOnly={!editing}
        requisition={data}
      />
    </>
  );
}
