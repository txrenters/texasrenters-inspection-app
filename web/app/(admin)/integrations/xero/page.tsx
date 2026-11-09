'use client';

import { connectedOrganisations, xeroCanWrite, type XeroOrganisationView } from '@texasrenters/shared';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermissions } from '@/lib/auth';
import { formatDate, formatRelative } from '@/lib/format';
import { useXeroActions, useXeroConnection, useXeroSending, useXeroSettings } from '@/lib/xero-queries';

/**
 * The office's Xero organisations (2026-11-10): the companies -- THMP, Crystal
 * Creek Pest, Crystal Creek Air and the like -- each keep their own books, and
 * one sign-in reaches whichever of them were ticked at Xero. A tab for each:
 * what the console read from it -- its details, Xero's id for it, its tax rates
 * -- its own choices of what goes where, and sending its invoices once that is
 * all in place.
 */
export default function XeroPage() {
  const { has } = usePermissions();
  const canRead = has('integrations:read');
  const canManage = has('integrations:manage');
  const connection = useXeroConnection(canRead);
  const actions = useXeroActions();
  const [tab, setTab] = useState<string | null>(null);
  // 'all' for the whole sign-in, or one organisation's id.
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  if (connection.isLoading) return <PageSkeleton />;
  if (connection.isError || !connection.data) return <ErrorState error={connection.error} retry={() => void connection.refetch()} />;
  const xero = connection.data;
  const connected = xero.status === 'CONNECTED';
  const live = connectedOrganisations(xero);
  const removed = xero.organisations.filter((organisation) => organisation.status === 'REMOVED');
  const shown = live.find((organisation) => organisation.tenantId === tab)?.tenantId ?? live[0]?.tenantId;
  const leaving = disconnecting && disconnecting !== 'all' ? live.find((organisation) => organisation.tenantId === disconnecting) : undefined;

  // Sign-in happens at Xero, in a tab of its own opened from the click, so the browser does not take it for a pop-up.
  const connect = async () => {
    try {
      const { authorizationUrl } = await actions.authorize.mutateAsync();
      window.open(authorizationUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast.error('Xero could not be opened', { description: error instanceof Error ? error.message : undefined });
    }
  };
  const read = (organisation: XeroOrganisationView) =>
    actions.read.mutate(organisation.tenantId, {
      onSuccess: () => toast.success(`Read ${organisation.name} from Xero`),
      onError: (error) => toast.error('Xero was not read', { description: error.message }),
    });
  const disconnect = () => {
    const done = (result: { removedAtXero: boolean }) => {
      setDisconnecting(null);
      toast.success(disconnecting === 'all' ? 'Xero disconnected' : `${leaving?.name ?? 'The organisation'} disconnected`, {
        description: result.removedAtXero ? undefined : 'Xero did not confirm it: remove the console under Connected apps in Xero too.',
      });
    };
    const failed = (error: Error) => toast.error('Not disconnected', { description: error.message });
    if (disconnecting === 'all') actions.disconnect.mutate(undefined, { onSuccess: done, onError: failed });
    else if (disconnecting) actions.disconnectOrganisation.mutate(disconnecting, { onSuccess: done, onError: failed });
  };
  const disconnectPending = actions.disconnect.isPending || actions.disconnectOrganisation.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          canManage && xero.configured ? (
            connected ? (
              <>
                {/* Connected before sending, to read only: Xero must be asked again before anything can be written. */}
                {!xeroCanWrite(xero.scopes) ? (
                  <Button disabled={actions.authorize.isPending} onClick={() => void connect()}>
                    Allow sending
                  </Button>
                ) : null}
                {/* Xero's own screen is where organisations are ticked or unticked: the same sign-in again. */}
                <Button disabled={actions.authorize.isPending} onClick={() => void connect()} variant="outline">
                  Add or remove organisations
                </Button>
                <Button className="text-destructive hover:text-destructive" onClick={() => setDisconnecting('all')} variant="outline">
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
        description="Each company's books, an organisation of its own. Choose what goes where in each, then send its invoices; payments come next."
        info={
          <>
            <p>
              Somebody who can sign in to the companies&apos; Xero connects once and ticks every organisation to use -- THMP,
              Crystal Creek Pest, Crystal Creek Air. The console keeps the sign-in encrypted and reads each organisation&apos;s
              details, accounts and tax rates. Signing in again adds or removes organisations.
            </p>
            <p>
              Each read is four calls to that organisation, and sending makes calls only for invoices that changed, up to 50 to
              a call. Xero allows each organisation 1,000 a day on its free plan; the console stops at {xero.dailyCeiling}.
              Choosing accounts uses the last read and calls Xero not at all.
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

      {connected && live.length ? (
        <Tabs onValueChange={setTab} value={shown}>
          <TabsList>
            {live.map((organisation) => (
              <TabsTrigger key={organisation.tenantId} value={organisation.tenantId}>
                {organisation.name}
              </TabsTrigger>
            ))}
          </TabsList>
          {live.map((organisation) => (
            <TabsContent className="mt-4" key={organisation.tenantId} value={organisation.tenantId}>
              <OrganisationTab
                canManage={canManage}
                canRead={canRead}
                dailyCeiling={xero.dailyCeiling}
                onDisconnect={() => setDisconnecting(organisation.tenantId)}
                onRead={() => read(organisation)}
                organisation={organisation}
                reading={actions.read.isPending && actions.read.variables === organisation.tenantId}
              />
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <Panel bodyClassName="p-4" title="Not connected">
          <p className="text-muted-foreground text-sm">
            {connected
              ? 'The sign-in reaches no organisation now. Add one, ticking it at Xero.'
              : `${xero.disconnectedAt ? `Disconnected ${formatRelative(xero.disconnectedAt)}. ` : ''}Nothing is read from Xero until it is connected, and nothing is sent to it.`}
          </p>
        </Panel>
      )}

      {removed.length ? (
        <Panel count={removed.length} title="No longer connected">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organisation</TableHead>
                <TableHead>Xero ID</TableHead>
                <TableHead>Since</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {removed.map((organisation) => (
                <TableRow key={organisation.tenantId}>
                  <TableCell>{organisation.name}</TableCell>
                  <TableCell className="font-mono text-xs">{organisation.tenantId}</TableCell>
                  <TableCell className="text-muted-foreground">{organisation.removedAt ? formatDate(organisation.removedAt) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      ) : null}

      <AlertDialog onOpenChange={(open) => (open ? undefined : setDisconnecting(null))} open={disconnecting !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{disconnecting === 'all' ? 'Disconnect Xero?' : `Disconnect ${leaving?.name ?? 'this organisation'}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {disconnecting === 'all'
                ? 'The console forgets its sign-in and asks Xero to end the link to every organisation. Nothing in Xero changes. Connecting again needs somebody who can sign in to Xero.'
                : 'The console stops reading this organisation and asks Xero to end its link; the others stay connected. Nothing in Xero changes, and what was chosen for it is kept.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnectPending}
              onClick={(event) => {
                event.preventDefault();
                disconnect();
              }}
            >
              {disconnectPending ? 'Disconnecting…' : 'Disconnect'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** One organisation: what was read from it, and its own choices of what goes where. */
function OrganisationTab({
  organisation,
  dailyCeiling,
  canRead,
  canManage,
  reading,
  onRead,
  onDisconnect,
}: {
  organisation: XeroOrganisationView;
  dailyCeiling: number;
  canRead: boolean;
  canManage: boolean;
  reading: boolean;
  onRead: () => void;
  onDisconnect: () => void;
}) {
  const settings = useXeroSettings(organisation.tenantId, canRead);
  const sending = useXeroSending(organisation.tenantId, canRead);
  const details = organisation.organisation;
  return (
    <div className="space-y-6">
      {organisation.readProblem ? (
        <Alert variant="destructive">
          <AlertDescription>The last read failed: {organisation.readProblem}</AlertDescription>
        </Alert>
      ) : null}

      <Panel
        actions={
          canManage ? (
            <>
              <Button disabled={reading} onClick={onRead} size="sm" variant="outline">
                {reading ? 'Reading…' : 'Read from Xero'}
              </Button>
              <Button className="text-destructive hover:text-destructive" onClick={onDisconnect} size="sm" variant="outline">
                Disconnect
              </Button>
            </>
          ) : null
        }
        bodyClassName="p-4"
        title="Organisation"
      >
        <DetailList
          items={[
            { label: 'Name', value: details?.name ?? organisation.name },
            { label: 'Legal name', value: details?.legalName ?? '—' },
            { label: 'Xero ID', value: <span className="font-mono text-xs">{organisation.tenantId}</span> },
            { label: 'Currency', value: details?.baseCurrency ?? '—' },
            { label: 'Country', value: details?.countryCode ?? '—' },
            { label: 'Sales tax', value: details?.salesTaxBasis ?? '—' },
            { label: 'Connected', value: organisation.connectedAt ? formatRelative(organisation.connectedAt) : '—' },
            { label: 'Last read', value: organisation.readAt ? formatRelative(organisation.readAt) : 'Not yet' },
            { label: 'Calls today', value: `${organisation.callsToday} of ${dailyCeiling}` },
          ]}
        />
      </Panel>

      <Panel count={organisation.taxRates.length} title="Tax rates">
        {organisation.taxRates.length ? (
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
              {organisation.taxRates.map((rate) => (
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
          accounts={organisation.accounts}
          canManage={canManage}
          key={`${organisation.tenantId}:${settings.data.updatedAt ?? 'new'}`}
          taxRates={organisation.taxRates}
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
    </div>
  );
}
