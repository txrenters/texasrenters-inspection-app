'use client';

import { xeroCanWrite } from '@texasrenters/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import { DetailList } from '@/components/detail-list';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { XeroSendingPanel } from '@/components/xero/xero-sending-panel';
import { XeroSettingsForm } from '@/components/xero/xero-settings-form';
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
import { useXeroActions, useXeroConnection, useXeroSending, useXeroSettings } from '@/lib/xero-queries';

/**
 * The office's Xero organisation (2026-11-10, phases 1-3 of the Xero plan):
 * connect it, see what the console read from it, choose what goes where --
 * the start date, the account each product or service and each payment method
 * goes to, the tax type -- and send its invoices once that is all in place.
 */
export default function XeroPage() {
  const { has } = usePermissions();
  const canRead = has('integrations:read');
  const canManage = has('integrations:manage');
  const connection = useXeroConnection(canRead);
  const connected = connection.data?.status === 'CONNECTED';
  const settings = useXeroSettings(canRead && connected);
  const sending = useXeroSending(canRead && connected);
  const actions = useXeroActions();
  const [disconnecting, setDisconnecting] = useState(false);

  if (connection.isLoading) return <PageSkeleton />;
  if (connection.isError || !connection.data) return <ErrorState error={connection.error} retry={() => void connection.refetch()} />;
  const xero = connection.data;

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

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          canManage && xero.configured ? (
            connected ? (
              <>
                {/* Connected before phase 3, to read only: Xero must be asked again before anything can be written. */}
                {!xeroCanWrite(xero.scopes) ? (
                  <Button disabled={actions.authorize.isPending} onClick={() => void connect()}>
                    Allow sending
                  </Button>
                ) : null}
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
        description="The office's books. Choose what goes where, then send its invoices; payments come next."
        info={
          <>
            <p>
              Somebody who can sign in to the office&apos;s Xero connects it once, choosing the one organisation. The console
              keeps the sign-in encrypted and reads the organisation&apos;s details, accounts, tax rates and whether Xero&apos;s
              own invoice reminders are on.
            </p>
            <p>
              Each read is four calls to Xero. Sending makes calls only for invoices that changed, up to 50 to a call. The
              console makes at most {xero.dailyCeiling} a day, below the 1,000 Xero allows on its free plan. Choosing
              accounts uses the last read and calls Xero not at all.
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

          {settings.data ? (
            // Keyed by the save it shows, so a save -- the office's or somebody else's -- starts it afresh.
            <XeroSettingsForm
              accounts={xero.accounts}
              canManage={canManage}
              key={settings.data.updatedAt ?? 'new'}
              taxRates={xero.taxRates}
              view={settings.data}
            />
          ) : settings.isError ? (
            <ErrorState error={settings.error} retry={() => void settings.refetch()} />
          ) : (
            <PageSkeleton />
          )}

          {sending.data ? (
            <XeroSendingPanel canManage={canManage} sendFrom={settings.data?.values.sendFrom ?? null} view={sending.data} />
          ) : sending.isError ? (
            <ErrorState error={sending.error} retry={() => void sending.refetch()} />
          ) : null}
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
