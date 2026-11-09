'use client';

import { paymentAccounts, revenueAccounts, type XeroAccount } from '@texasrenters/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import { DetailList } from '@/components/detail-list';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePermissions } from '@/lib/auth';
import { formatRelative } from '@/lib/format';
import { useXeroActions, useXeroConnection } from '@/lib/xero-queries';

/**
 * The office's Xero organisation (2026-11-10, phase 1 of the Xero plan):
 * connect it, then see what the console read from it -- its details, the
 * accounts a sale and a payment can be posted to, and its tax rates. The
 * next phase maps the console's products and payment methods onto these.
 * Nothing is written to Xero yet.
 */
export default function XeroPage() {
  const { has } = usePermissions();
  const canRead = has('integrations:read');
  const canManage = has('integrations:manage');
  const connection = useXeroConnection(canRead);
  const actions = useXeroActions();
  const [disconnecting, setDisconnecting] = useState(false);

  if (connection.isLoading) return <PageSkeleton />;
  if (connection.isError || !connection.data) return <ErrorState error={connection.error} retry={() => void connection.refetch()} />;
  const xero = connection.data;
  const connected = xero.status === 'CONNECTED';

  // Sign-in happens at Xero, in a tab of its own opened from the click, so the browser does not take it for a pop-up.
  const connect = async () => {
    try {
      const { authorizationUrl } = await actions.authorize.mutateAsync();
      window.open(authorizationUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast.error('Xero could not be opened', { description: error instanceof Error ? error.message : undefined });
    }
  };
  const read = () =>
    actions.read.mutate(undefined, {
      onSuccess: () => toast.success('Read from Xero'),
      onError: (error) => toast.error('Xero was not read', { description: error.message }),
    });
  const disconnect = () =>
    actions.disconnect.mutate(undefined, {
      onSuccess: (result) => {
        setDisconnecting(false);
        toast.success('Xero disconnected', {
          description: result.removedAtXero ? undefined : 'Xero did not confirm it: remove the console under Connected apps in Xero too.',
        });
      },
      onError: (error) => toast.error('Xero was not disconnected', { description: error.message }),
    });

  const revenue = revenueAccounts(xero.accounts);
  const payable = paymentAccounts(xero.accounts);

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          canManage && xero.configured ? (
            connected ? (
              <>
                <Button disabled={actions.read.isPending} onClick={read} variant="outline">
                  {actions.read.isPending ? 'Reading…' : 'Read from Xero'}
                </Button>
                <Button className="text-destructive hover:text-destructive" onClick={() => setDisconnecting(true)} variant="outline">
                  Disconnect
                </Button>
              </>
            ) : (
              <Button disabled={actions.authorize.isPending} onClick={() => void connect()}>
                {xero.status === 'REAUTHORIZATION_REQUIRED' ? 'Connect again' : 'Connect Xero'}
              </Button>
            )
          ) : undefined
        }
        badges={<StatusBadge value={xero.status} />}
        description="The office's books. The console reads them for now; sending invoices and payments comes next."
        info={
          <>
            <p>
              Somebody who can sign in to the office&apos;s Xero connects it once, choosing the one organisation. The console
              keeps the sign-in encrypted and reads the organisation&apos;s details, accounts and tax rates.
            </p>
            <p>
              Each read is three calls to Xero. The console makes at most {xero.dailyCeiling} a day, below the 1,000 Xero
              allows on its free plan.
            </p>
          </>
        }
        infoLabel="How Xero is connected"
        title="Xero"
      />

      {!xero.configured ? (
        <Alert>
          <AlertDescription>
            Xero is not set up on this server yet: it needs a Xero app&apos;s client ID, secret and redirect address, and its
            own encryption key.
          </AlertDescription>
        </Alert>
      ) : null}
      {xero.problem ? (
        <Alert variant="destructive">
          <AlertDescription>{xero.problem}</AlertDescription>
        </Alert>
      ) : null}
      {xero.readProblem ? (
        <Alert variant="destructive">
          <AlertDescription>The last read failed: {xero.readProblem}</AlertDescription>
        </Alert>
      ) : null}

      {connected ? (
        <>
          <Panel bodyClassName="p-4" title="Organisation">
            <DetailList
              items={[
                { label: 'Name', value: xero.organisation?.name ?? xero.tenantName ?? '—' },
                { label: 'Legal name', value: xero.organisation?.legalName ?? '—' },
                { label: 'Currency', value: xero.organisation?.baseCurrency ?? '—' },
                { label: 'Country', value: xero.organisation?.countryCode ?? '—' },
                { label: 'Sales tax', value: xero.organisation?.salesTaxBasis ?? '—' },
                { label: 'Connected', value: xero.connectedAt ? formatRelative(xero.connectedAt) : '—' },
                { label: 'Last read', value: xero.readAt ? formatRelative(xero.readAt) : 'Not yet' },
                { label: 'Calls today', value: `${xero.callsToday} of ${xero.dailyCeiling}` },
              ]}
            />
          </Panel>

          <AccountsPanel accounts={revenue} empty="No active revenue account with a code." title="Where sales go" />
          <AccountsPanel accounts={payable} empty="No bank account, or account taking payments." title="Where payments land" />

          <Panel count={xero.taxRates.length} title="Tax rates">
            {xero.taxRates.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Tax type</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {xero.taxRates.map((rate) => (
                    <TableRow key={rate.taxType}>
                      <TableCell>{rate.name}</TableCell>
                      <TableCell className="font-mono text-xs">{rate.taxType}</TableCell>
                      <TableCell className="text-right tabular-nums">{rate.effectiveRate === null ? '—' : `${rate.effectiveRate}%`}</TableCell>
                      <TableCell className="text-muted-foreground">{rate.status.toLowerCase()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-muted-foreground px-4 py-3 text-sm">None read yet.</p>
            )}
          </Panel>
        </>
      ) : (
        <Panel bodyClassName="p-4" title="Not connected">
          <p className="text-muted-foreground text-sm">
            {xero.disconnectedAt ? `Disconnected ${formatRelative(xero.disconnectedAt)}. ` : ''}
            Nothing is read from Xero until it is connected, and nothing is sent to it.
          </p>
        </Panel>
      )}

      <AlertDialog onOpenChange={(open) => (open ? undefined : setDisconnecting(false))} open={disconnecting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Xero?</AlertDialogTitle>
            <AlertDialogDescription>
              The console forgets its sign-in and asks Xero to end the link. Nothing in Xero changes. Connecting again needs
              somebody who can sign in to Xero.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={actions.disconnect.isPending}
              onClick={(event) => {
                event.preventDefault();
                disconnect();
              }}
            >
              {actions.disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AccountsPanel({ title, accounts, empty }: { title: string; accounts: readonly XeroAccount[]; empty: string }) {
  return (
    <Panel count={accounts.length} title={title}>
      {accounts.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => (
              <TableRow key={account.accountId}>
                <TableCell className="font-mono text-xs">{account.code ?? '—'}</TableCell>
                <TableCell>{account.name}</TableCell>
                <TableCell className="text-muted-foreground">{account.type.toLowerCase()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-muted-foreground px-4 py-3 text-sm">{empty}</p>
      )}
    </Panel>
  );
}
