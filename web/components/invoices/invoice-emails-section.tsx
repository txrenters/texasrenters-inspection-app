'use client';

import {
  MAX_FOLLOW_UP_DAY,
  MAX_FOLLOW_UP_STEPS,
  followUpDaysProblem,
  followUpWhen,
  sortedFollowUpDays,
  type InvoiceEmailSettingsView,
} from '@texasrenters/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { useInvoiceEmailSettings, useSaveInvoiceEmailSettings } from '@/lib/invoice-delivery-queries';

/**
 * The emails Jobber sent by itself, and the console sends once it owns
 * invoicing (2026-11-09, phase 1 of the invoice gap review): a follow-up to
 * the client on the day an unpaid invoice is due and four days after, as
 * Jobber's two automations did, and -- if the office wants -- a receipt when a
 * payment is recorded. Nothing here sends anything before Take over.
 */
export function InvoiceEmailsSection({ mayChange }: { mayChange: boolean }) {
  const settings = useInvoiceEmailSettings();
  if (settings.isLoading || !settings.data) return null;
  // Started again from what was saved, each time it is saved.
  return <EmailsForm key={settings.data.updatedAt ?? 'never'} mayChange={mayChange} view={settings.data} />;
}

function EmailsForm({ view, mayChange }: { view: InvoiceEmailSettingsView; mayChange: boolean }) {
  const id = useId();
  const save = useSaveInvoiceEmailSettings();
  const [followUps, setFollowUps] = useState(view.followUpsEnabled);
  const [days, setDays] = useState<number[]>(sortedFollowUpDays(view.followUpDays));
  const [receipts, setReceipts] = useState(view.receiptsAutomatic);
  const [adding, setAdding] = useState('');

  const typed = adding.trim() === '' ? null : Number(adding);
  const addProblem =
    typed === null
      ? null
      : !Number.isInteger(typed) || typed < 0 || typed > MAX_FOLLOW_UP_DAY
        ? `From 0, the due date, to ${MAX_FOLLOW_UP_DAY} days after it.`
        : days.includes(typed)
          ? 'There is a follow-up on that day already.'
          : null;
  const problem = followUpDaysProblem(days);
  const dirty =
    followUps !== view.followUpsEnabled ||
    receipts !== view.receiptsAutomatic ||
    days.join(',') !== sortedFollowUpDays(view.followUpDays).join(',');

  const add = () => {
    if (typed === null || addProblem) return;
    setDays((current) => sortedFollowUpDays([...current, typed]));
    setAdding('');
  };

  const submit = () =>
    save.mutate(
      { followUpsEnabled: followUps, followUpDays: days, receiptsAutomatic: receipts, expectedUpdatedAt: view.updatedAt },
      {
        onSuccess: () => toast.success('Reminders and receipts saved'),
        onError: (error) =>
          toast.error('Nothing was saved', {
            description:
              error instanceof ApiError && error.status === 409 ? `${error.message} The page now shows them as they are.` : error.message,
          }),
      },
    );

  return (
    <section aria-label="Reminders and receipts" className="bg-card mt-6 rounded-lg border p-4">
      <h2 className="text-heading text-lg font-bold">Reminders and receipts</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        The emails Jobber sends by itself. Once the console takes over invoicing it sends them instead, to whoever each invoice was
        last emailed to, or the client&apos;s own addresses.
      </p>
      {view.takenOver ? (
        <p className="border-warning/40 bg-warning/10 mt-3 rounded-md border px-3 py-2 text-sm" role="note">
          Turn off Jobber&apos;s two invoice follow-up automations in Jobber. Jobber still holds its own copy of
          every invoice it made, unpaid, and would keep emailing clients about them.
        </p>
      ) : (
        <p className="text-muted-foreground mt-3 text-sm" role="note">
          Nothing here is sent until the console takes over invoicing: until then Jobber sends its own, and two would reach the
          client.
        </p>
      )}

      <div className="mt-4 grid gap-4">
        <div className="flex items-start gap-2">
          <Checkbox
            checked={followUps}
            disabled={!mayChange}
            id={`${id}-follow-ups`}
            onCheckedChange={(value) => setFollowUps(value === true)}
          />
          <div className="grid gap-1">
            <Label className="font-medium" htmlFor={`${id}-follow-ups`}>
              Email clients about unpaid invoices
            </Label>
            <p className="text-muted-foreground text-xs">
              At 1:30 PM Texas time, about each invoice still awaiting payment, in Jobber&apos;s words: &ldquo;Your invoice is due
              today&rdquo;, &ldquo;… is 4 days overdue&rdquo;.
            </p>
          </div>
        </div>

        {followUps ? (
          <div className="ml-6 grid gap-2">
            {days.length ? (
              <ul aria-label="When they go" className="grid gap-1 text-sm">
                {days.map((day) => (
                  <li className="flex items-center justify-between gap-3 rounded-md border px-3 py-1.5" key={day}>
                    <span>{followUpWhen(day)}</span>
                    {mayChange ? (
                      <Button
                        aria-label={`Remove the follow-up ${followUpWhen(day).toLowerCase()}`}
                        onClick={() => setDays((current) => current.filter((item) => item !== day))}
                        size="sm"
                        variant="ghost"
                      >
                        Remove
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">No days chosen, so none are sent.</p>
            )}
            {mayChange && days.length < MAX_FOLLOW_UP_STEPS ? (
              <div className="flex flex-wrap items-end gap-2">
                <Field className="w-auto">
                  <FieldLabel htmlFor={`${id}-add`}>Days after the due date</FieldLabel>
                  <Input
                    className="w-28 tabular-nums"
                    id={`${id}-add`}
                    inputMode="numeric"
                    max={MAX_FOLLOW_UP_DAY}
                    min={0}
                    onChange={(event) => setAdding(event.target.value)}
                    onKeyDown={(event) => (event.key === 'Enter' ? add() : undefined)}
                    type="number"
                    value={adding}
                  />
                </Field>
                <Button disabled={typed === null || Boolean(addProblem)} onClick={add} size="sm" variant="outline">
                  Add a follow-up
                </Button>
                {addProblem ? (
                  <p aria-live="polite" className="text-destructive w-full text-xs">
                    {addProblem}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-start gap-2">
          <Checkbox checked={receipts} disabled={!mayChange} id={`${id}-receipts`} onCheckedChange={(value) => setReceipts(value === true)} />
          <div className="grid gap-1">
            <Label className="font-medium" htmlFor={`${id}-receipts`}>
              Email a receipt when a payment is recorded here
            </Label>
            <p className="text-muted-foreground text-xs">
              Off, a receipt goes only when somebody presses Email receipt on the payment.
            </p>
          </div>
        </div>
      </div>

      <p className="text-muted-foreground mt-4 text-xs">
        Every one counts toward the console&apos;s 200 invoice emails a day. Past that, nothing more is sent that day: a follow-up missed then is not sent later.
      </p>

      {mayChange ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
          <p aria-live="polite" className={problem ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
            {problem ?? (dirty ? 'Not saved yet.' : '')}
          </p>
          <Button disabled={!dirty || Boolean(problem) || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save reminders and receipts'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
