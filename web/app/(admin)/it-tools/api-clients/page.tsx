'use client';

import type { ApiClientSummary, IssuedApiKey } from '@texasrenters/shared';
import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';

import { ApiClientDialog } from '@/components/api-client-dialog';
import { PageHeader, SectionHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatPermission } from '@/lib/access';
import { formatRelative } from '@/lib/format';
import { useApiClientMutations, useApiClients } from '@/lib/queries';
import { useUrlState } from '@/lib/url-state';

const PAGE_SIZE = 20;

/**
 * The one screen where a secret is visible.
 *
 * Modal and blocking, because the value cannot be recovered: only a keyed hash
 * is stored, so a dialog dismissed before the key was copied has destroyed it.
 * That is stated here rather than left to be discovered.
 */
function IssuedKeyDialog({ issued, onClose }: { issued: IssuedApiKey; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.key);
      setCopied(true);
    } catch {
      // Clipboard permission can be refused; the value is selectable either way.
    }
  };

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Copy this key now</DialogTitle>
          <DialogDescription>
            It is shown once. The server stores only a hash of it, so if you close this without
            copying it, the key is gone and you will need to issue another.
          </DialogDescription>
        </DialogHeader>
        <div className="bg-muted/40 rounded-md border p-3">
          <code className="text-xs break-all">{issued.key}</code>
        </div>
        <Alert variant="warning">
          <ShieldAlertIcon aria-hidden />
          <AlertDescription>
            Server-to-server only. A key placed in browser JavaScript, a mobile app bundle, or a
            committed configuration file is a published key.
          </AlertDescription>
        </Alert>
        <DialogFooter>
          <Button onClick={() => void copy()} variant={copied ? 'ghost' : 'default'}>
            {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {copied ? 'Copied' : 'Copy key'}
          </Button>
          <Button disabled={!copied} onClick={onClose} variant="outline">
            I have stored it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyRow({
  clientId,
  keyRecord,
  onRevoke,
}: {
  clientId: string;
  keyRecord: ApiClientSummary['keys'][number];
  onRevoke: (input: { id: string; keyId: string }) => void;
}) {
  const expired = keyRecord.expiresAt ? new Date(keyRecord.expiresAt) <= new Date() : false;
  const dead = Boolean(keyRecord.revokedAt) || expired;

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b py-2 last:border-0">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-xs">trk_…{keyRecord.prefix}</code>
          {keyRecord.label ? <span className="text-sm">{keyRecord.label}</span> : null}
          {keyRecord.revokedAt ? <Badge variant="destructive">Revoked</Badge> : null}
          {expired && !keyRecord.revokedAt ? <Badge variant="secondary">Expired</Badge> : null}
        </div>
        <p className="text-muted-foreground text-xs">
          {keyRecord.lastUsedAt
            ? `Last used ${formatRelative(keyRecord.lastUsedAt)}${keyRecord.lastUsedIp ? ` from ${keyRecord.lastUsedIp}` : ''}`
            : 'Never used'}
          {keyRecord.expiresAt ? ` · expires ${formatRelative(keyRecord.expiresAt)}` : ''}
        </p>
      </div>
      {dead ? null : (
        <Button
          onClick={() => onRevoke({ id: clientId, keyId: keyRecord.id })}
          size="sm"
          variant="ghost"
        >
          <Trash2Icon aria-hidden />
          Revoke
        </Button>
      )}
    </li>
  );
}

/**
 * Third-party integrations and the credentials they hold.
 *
 * A client is an identity with scopes; a key is one credential for it. They are
 * separate so a key can be rotated without the integration losing its identity,
 * its permissions or its audit history — issue the replacement, let both work
 * while the third party redeploys, then revoke the old one.
 */
export default function ApiClientsPage() {
  const [state, setState] = useUrlState({ page: 1, search: '' });
  const clients = useApiClients({ page: state.page, pageSize: PAGE_SIZE, search: state.search });
  const { createClient, issueKey, revokeClient, revokeKey, updateClient } = useApiClientMutations();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ApiClientSummary | null>(null);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiClientSummary | null>(null);

  if (clients.isPending) return <PageSkeleton />;
  if (clients.isError)
    return <ErrorState error={clients.error} retry={() => void clients.refetch()} />;

  const records = clients.data?.data ?? [];

  return (
    <>
      <PageHeader
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <PlusIcon aria-hidden />
            Register client
          </Button>
        }
        description="Registered integrations, the permissions each one holds, and the keys they authenticate with."
        title="API clients"
      />

      <Alert className="mb-4">
        <KeyRoundIcon aria-hidden />
        <AlertTitle>How an integration authenticates</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            Send the key as <code className="text-xs">x-api-key</code>. A client with write scopes
            must also send <code className="text-xs">x-timestamp</code> and{' '}
            <code className="text-xs">x-signature</code> — an HMAC-SHA256 of{' '}
            <code className="text-xs">METHOD\npath\ntimestamp\nsha256(body)</code> keyed with the
            key&apos;s secret, within five minutes of now.
          </p>
          <p className="text-muted-foreground">
            Keys reach only the routes marked “Open to integrations” in the API reference. Holding a
            matching permission is not enough on its own.
          </p>
        </AlertDescription>
      </Alert>

      <Input
        aria-label="Search API clients"
        className="mb-4 max-w-sm"
        onChange={(event) => setState({ search: event.target.value, page: 1 })}
        placeholder="Search by name"
        value={state.search}
      />

      {records.length === 0 ? (
        <EmptyState
          description="Register one to give a third-party system scoped, rate-limited access to this API."
          icon={KeyRoundIcon}
          title="No API clients yet"
        />
      ) : (
        <div className="space-y-3">
          {records.map((client) => (
            <Card key={client.id}>
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {client.name}
                    <Badge variant={client.environment === 'LIVE' ? 'default' : 'secondary'}>
                      {client.environment === 'LIVE' ? 'Live' : 'Test'}
                    </Badge>
                    {client.isActive ? null : <Badge variant="destructive">Revoked</Badge>}
                    {client.requireSignature ? <Badge variant="secondary">Signed</Badge> : null}
                  </CardTitle>
                  {client.description ? (
                    <p className="text-muted-foreground text-sm">{client.description}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-1">
                    {client.permissions.length ? (
                      client.permissions.map((permission) => (
                        <Badge key={permission} variant="secondary">
                          {formatPermission(permission)}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-warning text-sm">No permissions</span>
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs tabular-nums">
                    {client.rateLimitPerMinute} requests/minute
                    {client.allowedIps.length
                      ? ` · from ${client.allowedIps.join(', ')}`
                      : ' · from any address'}
                  </p>
                </div>
                {client.isActive ? (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      onClick={() => {
                        setEditing(client);
                        setDialogOpen(true);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <PencilIcon aria-hidden />
                      Edit
                    </Button>
                    <Button
                      disabled={issueKey.isPending}
                      onClick={() =>
                        issueKey.mutate(
                          { id: client.id },
                          { onSuccess: (data) => setIssued(data) },
                        )
                      }
                      size="sm"
                    >
                      <KeyRoundIcon aria-hidden />
                      Issue key
                    </Button>
                    <Button onClick={() => setRevoking(client)} size="sm" variant="ghost">
                      <Trash2Icon aria-hidden />
                      Revoke client
                    </Button>
                  </div>
                ) : null}
              </CardHeader>
              <CardContent>
                <SectionHeader title="Keys" />
                {client.keys.length ? (
                  <ul className="mt-1">
                    {client.keys.map((keyRecord) => (
                      <KeyRow
                        clientId={client.id}
                        key={keyRecord.id}
                        keyRecord={keyRecord}
                        onRevoke={(input) => revokeKey.mutate(input)}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground mt-1 text-sm">
                    No keys issued. This client cannot authenticate until one is.
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Pagination
        onPage={(page) => setState({ page })}
        page={state.page}
        total={clients.data?.total ?? 0}
        totalPages={Math.max(1, Math.ceil((clients.data?.total ?? 0) / PAGE_SIZE))}
      />

      {dialogOpen ? (
        <ApiClientDialog
          client={editing}
          onClose={() => setDialogOpen(false)}
          onSubmit={(input) => {
            const done = { onSuccess: () => setDialogOpen(false) };
            if (editing) updateClient.mutate({ id: editing.id, ...input }, done);
            else createClient.mutate(input, done);
          }}
          open
          pending={createClient.isPending || updateClient.isPending}
        />
      ) : null}

      {issued ? <IssuedKeyDialog issued={issued} onClose={() => setIssued(null)} /> : null}

      <AlertDialog onOpenChange={(open) => (open ? undefined : setRevoking(null))} open={!!revoking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every key it holds stops working immediately. The client is kept rather than deleted,
              so the actions it has already taken stay attributable in the audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revoking) revokeClient.mutate(revoking.id);
                setRevoking(null);
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
