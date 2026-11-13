'use client';

import type { InvoiceAutoDraftsView } from '@texasrenters/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { useInvoiceAutoDrafts, useSaveInvoiceAutoDrafts } from '@/lib/invoice-auto-drafts-queries';

const moment = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }).format(
    new Date(iso),
  );

/**
 * "Draft invoices automatically" (2026-11-13): each visit finished from the
 * moment it is turned on gets its invoices by itself, by the rules above, as a
 * draft in its company's Xero for accounting to check -- the office asked that
 * accounting "only double check them and add the missing data".
 */
export function InvoiceAutoDraftsSection({ mayChange }: { mayChange: boolean }) {
  const drafts = useInvoiceAutoDrafts();
  if (drafts.isLoading || !drafts.data) return null;
  // Started again from what was saved, each time it is saved.
  return <AutoDraftsForm key={drafts.data.updatedAt ?? 'never'} mayChange={mayChange} view={drafts.data} />;
}

function AutoDraftsForm({ view, mayChange }: { view: InvoiceAutoDraftsView; mayChange: boolean }) {
  const id = useId();
  const save = useSaveInvoiceAutoDrafts();
  const [on, setOn] = useState(view.on);
  const dirty = on !== view.on;

  const submit = () =>
    save.mutate(
      { on, expectedUpdatedAt: view.updatedAt },
      {
        onSuccess: (saved) => toast.success(saved.on ? 'Invoices are drafted automatically' : 'Invoices are no longer drafted automatically'),
        onError: (error) =>
          toast.error('Nothing was saved', {
            description: error instanceof ApiError && error.status === 409 ? `${error.message}` : error.message,
          }),
      },
    );

  return (
    <section aria-label="Draft invoices automatically" className="bg-card mt-6 rounded-lg border p-4">
      <h2 className="text-heading text-lg font-bold">Draft invoices automatically</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Each visit finished from the moment this is on gets its invoices by itself, within about ten minutes: by the rules above,
        one for each company, dated on the visit&apos;s day and due at the end of that month. Each goes to its company&apos;s books
        in Xero as a draft, for accounting to check, add what is missing, and approve.
      </p>
      <p className="text-muted-foreground mt-2 text-sm">
        A visit no rule covers, one whose company does not send to Xero, and one the technician could not get into are left on
        Create invoices, with the reason. A visit that has or had an invoice is never drafted again.
      </p>
      {on ? (
        <p className="border-warning/40 bg-warning/10 mt-3 rounded-md border px-3 py-2 text-sm" role="note">
          Stop making these invoices by hand in Xero once this is on, or each visit is billed twice.
        </p>
      ) : null}
      {view.takenOver ? null : (
        <p className="text-muted-foreground mt-3 text-sm" role="note">
          Nothing is drafted until the console takes over invoicing.
        </p>
      )}

      <div className="mt-4 flex items-start gap-2">
        <Checkbox
          checked={on}
          disabled={!mayChange || (!view.takenOver && !view.on)}
          id={`${id}-on`}
          onCheckedChange={(value) => setOn(value === true)}
        />
        <div className="grid gap-1">
          <Label className="font-medium" htmlFor={`${id}-on`}>
            Draft each finished visit&apos;s invoices automatically
          </Label>
          <p className="text-muted-foreground text-xs">
            {view.on && view.since ? `On since ${moment(view.since)} Texas time.` : 'Off: the office makes them on Create invoices.'}
          </p>
        </div>
      </div>

      {mayChange ? (
        <div className="mt-4 flex justify-end">
          <Button disabled={!dirty || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
