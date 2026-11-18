'use client';

import type { PurchaseOrderDetail, XeroBillSendStatus } from '@texasrenters/shared';
import { ExternalLinkIcon } from 'lucide-react';

import { AsideCard, FactTable } from '@/components/record/record-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format';
import { useBillInXero, useBillInXeroActions } from '@/lib/vendor-bills-xero-queries';

/**
 * The bill in Xero (2026-11-19, phase 7). An approved bill is sent to its
 * company's books once, as a draft, when somebody presses "Send to Xero".
 * Once the office has approved it there, the payment recorded here can be
 * sent against it. Nothing goes by itself, and what is in Xero is never
 * changed from here. The buttons are drawn from what the server says this
 * person may do.
 */

const LABEL: Record<XeroBillSendStatus, string> = { NOT_SENT: 'Not sent', PENDING: 'Being sent', SENT: 'In Xero', FAILED: 'Not sent: see below' };
const TONE: Record<XeroBillSendStatus, 'secondary' | 'info' | 'success' | 'destructive'> = { NOT_SENT: 'secondary', PENDING: 'info', SENT: 'success', FAILED: 'destructive' };
const PAYMENT_LABEL: Record<XeroBillSendStatus, string> = { NOT_SENT: 'Not sent', PENDING: 'Being sent', SENT: 'Recorded in Xero', FAILED: 'Not sent: see below' };

export function BillInXeroSection({ data }: { data: PurchaseOrderDetail }) {
  const approved = data.bill?.status === 'APPROVED' || data.bill?.status === 'PAID';
  // Read only once there is an approved bill to send: until then there is nothing to say.
  const standing = useBillInXero(data.id, approved);
  const { send, sendPayment } = useBillInXeroActions(data.id);
  if (!approved) return null;
  const view = standing.data;
  const busy = send.isPending || sendPayment.isPending;
  const paid = data.bill?.status === 'PAID';

  return (
    <AsideCard
      action={
        view?.url ? (
          <Button asChild size="sm" variant="outline">
            <a href={view.url} rel="noreferrer" target="_blank">
              Open in Xero <ExternalLinkIcon aria-hidden="true" />
            </a>
          </Button>
        ) : undefined
      }
      title="The bill in Xero"
    >
      {standing.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{standing.error.message}</AlertDescription>
        </Alert>
      ) : !view ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Spinner /> Loading
        </p>
      ) : (
        <div className="grid gap-3">
          <FactTable
            facts={[
              { label: 'Company', value: view.company?.name ?? 'None' },
              { label: 'Bill', value: <Badge variant={TONE[view.status]}>{LABEL[view.status]}</Badge> },
              ...(view.sentAt ? [{ label: 'Sent', value: `${view.sentBy ?? 'Somebody'}, ${formatDateTime(view.sentAt)}` }] : []),
              ...(view.status === 'SENT' && (paid || view.payment.status !== 'NOT_SENT') ? [{ label: 'Payment', value: <Badge variant={TONE[view.payment.status]}>{PAYMENT_LABEL[view.payment.status]}</Badge> }] : []),
              ...(view.payment.sentAt ? [{ label: 'Payment sent', value: `${view.payment.sentBy ?? 'Somebody'}, ${formatDateTime(view.payment.sentAt)}` }] : []),
            ]}
            label="The bill in Xero"
          />

          {view.status !== 'SENT' ? (
            <>
              {view.problem ? (
                <Alert variant="destructive">
                  <AlertDescription>{view.problem}</AlertDescription>
                </Alert>
              ) : null}
              {send.error && send.error.message !== view.problem ? (
                <Alert variant="destructive">
                  <AlertDescription>{send.error.message}</AlertDescription>
                </Alert>
              ) : null}
              <p className="text-muted-foreground text-sm">{view.waitsOn ?? 'It goes once, as a draft bill. The office reviews and approves it in Xero.'}</p>
              {view.can.send ? (
                <Button className="justify-self-start" disabled={busy} onClick={() => send.mutate()} size="sm">
                  {send.isPending ? <Spinner /> : null}
                  {view.status === 'NOT_SENT' ? 'Send to Xero' : 'Try again'}
                </Button>
              ) : null}
            </>
          ) : view.payment.status === 'SENT' ? (
            <p className="text-muted-foreground text-sm">The bill and its payment are in Xero. Anything further is done there.</p>
          ) : (
            <>
              {view.payment.problem ? (
                <Alert variant="destructive">
                  <AlertDescription>{view.payment.problem}</AlertDescription>
                </Alert>
              ) : null}
              {sendPayment.error && sendPayment.error.message !== view.payment.problem ? (
                <Alert variant="destructive">
                  <AlertDescription>{sendPayment.error.message}</AlertDescription>
                </Alert>
              ) : null}
              <p className="text-muted-foreground text-sm">
                {view.paymentWaitsOn ?? 'Once the bill is approved in Xero, the payment recorded here can be sent against it. Xero takes no payment on a draft.'}
              </p>
              {view.can.sendPayment ? (
                <Button className="justify-self-start" disabled={busy} onClick={() => sendPayment.mutate()} size="sm">
                  {sendPayment.isPending ? <Spinner /> : null}
                  {view.payment.status === 'NOT_SENT' ? 'Send the payment to Xero' : 'Try the payment again'}
                </Button>
              ) : null}
            </>
          )}
        </div>
      )}
    </AsideCard>
  );
}
