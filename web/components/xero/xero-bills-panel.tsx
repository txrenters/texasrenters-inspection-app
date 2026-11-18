'use client';

import { VENDOR_PAYMENT_METHODS, VENDOR_PAYMENT_METHOD_LABEL, type VendorPaymentMethod, type XeroBillAccountOption, type XeroBillSettingsView } from '@texasrenters/shared';
import { useState, type FormEvent } from 'react';

import { Panel } from '@/components/panel';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useSaveXeroBillSettings, useXeroBillSettings } from '@/lib/vendor-bills-xero-queries';

/**
 * A company's choices for its vendor bills (2026-11-19, phase 7): the account
 * they are booked to, and the account each way of paying comes out of. Apart
 * from the invoice settings above it, and saved on its own. Choosing here
 * sends nothing: a bill goes when somebody presses "Send to Xero" on it.
 */

/** Radix's Select has no empty value: this stands for "none chosen". */
const NONE = 'none';
const label = (account: XeroBillAccountOption) => (account.code ? `${account.code} ${account.name}` : account.name);

export function XeroBillsPanel({ tenantId, canRead, canManage }: { tenantId: string; canRead: boolean; canManage: boolean }) {
  const settings = useXeroBillSettings(tenantId, canRead);
  if (!canRead) return null;
  return (
    <Panel bodyClassName="p-4" title="Vendor bills">
      {settings.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{settings.error.message}</AlertDescription>
        </Alert>
      ) : !settings.data ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Spinner /> Loading
        </p>
      ) : (
        // Keyed by what is saved, so a save starts the form afresh.
        <BillsForm canManage={canManage} key={JSON.stringify(settings.data.settings)} tenantId={tenantId} view={settings.data} />
      )}
    </Panel>
  );
}

function BillsForm({ view, tenantId, canManage }: { view: XeroBillSettingsView; tenantId: string; canManage: boolean }) {
  const save = useSaveXeroBillSettings(tenantId);
  const [purchases, setPurchases] = useState(view.settings.purchasesAccountId ?? NONE);
  const [accounts, setAccounts] = useState<Partial<Record<VendorPaymentMethod, string>>>(view.settings.paymentAccounts);
  const changed = purchases !== (view.settings.purchasesAccountId ?? NONE) || JSON.stringify(accounts) !== JSON.stringify(view.settings.paymentAccounts);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canManage || !changed || save.isPending) return;
    save.mutate({ purchasesAccountId: purchases === NONE ? null : purchases, paymentAccounts: accounts });
  }

  return (
    <form aria-label="Vendor bills" className="grid gap-4" onSubmit={submit}>
      <p className="text-muted-foreground text-sm">
        An approved vendor bill goes to these books as a draft when somebody presses &ldquo;Send to Xero&rdquo; on its purchase order. Nothing is sent by choosing here.
      </p>
      <Field>
        <FieldLabel htmlFor={`bills-purchases-${tenantId}`}>Account bills are booked to</FieldLabel>
        <Select disabled={!canManage} onValueChange={setPurchases} value={purchases}>
          <SelectTrigger className="w-full sm:w-96" id={`bills-purchases-${tenantId}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Not chosen</SelectItem>
            {view.purchaseAccounts.map((account) => (
              <SelectItem key={account.accountId} value={account.accountId}>
                {label(account)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          Every line of a bill, and its sales tax, goes to this one account: purchases, or inventory. A line can be moved on the draft in Xero. Until one is chosen, no bill can be sent.
        </FieldDescription>
      </Field>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Account each way of paying comes out of</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {VENDOR_PAYMENT_METHODS.map((method) => (
            <Field key={method}>
              <FieldLabel htmlFor={`bills-${method}-${tenantId}`}>{VENDOR_PAYMENT_METHOD_LABEL[method]}</FieldLabel>
              <Select
                disabled={!canManage}
                onValueChange={(value) =>
                  setAccounts((all) => {
                    const next = { ...all };
                    if (value === NONE) delete next[method];
                    else next[method] = value;
                    return next;
                  })
                }
                value={accounts[method] ?? NONE}
              >
                <SelectTrigger className="w-full" id={`bills-${method}-${tenantId}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not chosen</SelectItem>
                  {view.bankAccounts.map((account) => (
                    <SelectItem key={account.accountId} value={account.accountId}>
                      {label(account)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">Needed only to send a payment. A way of paying with no account chosen sends no payment; the bill still goes.</p>
      </fieldset>

      {save.error ? (
        <Alert variant="destructive">
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      ) : null}
      {canManage ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!changed || save.isPending} type="submit">
            {save.isPending ? <Spinner /> : null}
            Save
          </Button>
          <p aria-live="polite" className="text-muted-foreground text-sm">
            {save.isSuccess && !changed ? 'Saved.' : ''}
          </p>
        </div>
      ) : null}
    </form>
  );
}
