'use client';

import type { ApiClientSummary, IssuedApiKey } from '@texasrenters/shared';
import {
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';

import { ApiClientDialog } from '@/components/api-client-dialog';
import { CopyButton } from '@/components/api-reference/copy-button';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatPermission } from '@/lib/access';
import { formatRelative } from '@/lib/format';
import { useApiClientMutations, useApiClients } from '@/lib/queries';
import { useUrlState } from '@/lib/url-state';

const PAGE_SIZE = 20;

/**
 * The one screen where a secret is visible.
 *
 * Modal, because the value cannot be recovered: only a keyed hash is stored, so
 * a dialog dismissed before the secret was copied has destroyed it. That is
 * stated plainly rather than enforced — dismissal used to be gated on having
 * pressed Copy, which is defeated by pressing Copy and pasting nowhere, and cost
 * a disabled button with no obvious way to enable it. Re-issuing is one click.
 */
function IssuedKeyDialog({ issued, onClose }: { issued: IssuedApiKey; onClose: () => void }) {
  // The credential is `<key id>.<secret>`. Split rather than reconstructed from
  // `prefix`, so the parts shown are exactly the parts of the string issued.
  const separator = issued.key.indexOf('.');
  const keyIdPart = issued.key.slice(0, separator);
  const secretPart = issued.key.slice(separator + 1);

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Copy this key now</DialogTitle>
          <DialogDescription>
            The secret is shown once. The server stores only a hash of it, so if you close this
            without copying it, the key is gone and you will need to issue another. The Key ID stays
            visible in the table below.
          </DialogDescription>
        </DialogHeader>
        {/* Named parts, not one blob.
            
            This showed the whole credential under "Copy this key now", which
            reads as "this is the secret" — so it gets pasted into a Secret field
            and refused, because half of it is the Key ID. The anatomy has to be
            on screen at the one moment the reader meets it. */}
        <dl className="divide-y rounded-md border text-sm">
          <div className="grid gap-1 p-3 sm:grid-cols-[10rem_1fr] sm:items-center">
            <dt className="text-muted-foreground text-xs font-medium">Key ID (public)</dt>
            <dd className="flex items-center gap-1">
              <code className="text-xs break-all">{keyIdPart}</code>
              <CopyButton value={keyIdPart} />
            </dd>
          </div>
          <div className="grid gap-1 p-3 sm:grid-cols-[10rem_1fr] sm:items-center">
            <dt className="text-xs font-medium">
              Secret
              <span className="text-muted-foreground block font-normal">shown only here</span>
            </dt>
            <dd className="flex items-center gap-1">
              <code className="text-xs break-all">{secretPart}</code>
              <CopyButton value={secretPart} />
            </dd>
          </div>
        </dl>

        {/* The joining rule as a sentence, not a third value.
            
            Showing the joined credential as well meant three near-identical
            strings on one screen — the same ambiguity that made the single
            undifferentiated blob get pasted into the wrong field. It is also the
            one value here that can be reconstructed from the other two. */}
        <p className="text-muted-foreground text-xs">
          Send them joined, secret last:{' '}
          <code className="text-xs">x-api-key: &lt;key id&gt;.&lt;secret&gt;</code>
        </p>
        <Alert variant="warning">
          <ShieldAlertIcon aria-hidden />
          <AlertDescription>
            Server-to-server only. A key placed in browser JavaScript, a mobile app bundle, or a
            committed configuration file is a published key.
          </AlertDescription>
        </Alert>
        <DialogFooter>
          {/* One Copy per value, beside the value it copies. A second Copy in
              the footer duplicated the secret's own button, and gating dismissal
              on it left a disabled control with no obvious way to enable it —
              protection weak enough to defeat by clicking Copy and pasting
              nowhere, at the cost of a dead button. Re-issuing a key is one
              click, so the stakes never justified the gate. */}
          <Button onClick={onClose}>I have stored it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The full public half of a key.
 *
 * Was rendered `trk_…c913729304d1`, which is unusable: the API reference asks
 * for a Key ID like `trk_test_c913729304d1`, and the elided form does not tell
 * you the environment segment or that this *is* the Key ID. The whole value is
 * public by construction — it is the half that is safe to store and to share —
 * so there was never a reason to hide any of it.
 */
function keyId(environment: ApiClientSummary['environment'], prefix: string) {
  return `trk_${environment.toLowerCase()}_${prefix}`;
}

function KeyRow({
  clientId,
  environment,
  keyRecord,
  onRevoke,
}: {
  clientId: string;
  environment: ApiClientSummary['environment'];
  keyRecord: ApiClientSummary['keys'][number];
  onRevoke: (input: { id: string; keyId: string }) => void;
}) {
  const expired = keyRecord.expiresAt ? new Date(keyRecord.expiresAt) <= new Date() : false;
  const dead = Boolean(keyRecord.revokedAt) || expired;

  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="flex items-center gap-1">
          <code className="text-xs">{keyId(environment, keyRecord.prefix)}</code>
          <CopyButton label="Copy" value={keyId(environment, keyRecord.prefix)} />
        </div>
      </TableCell>
      <TableCell className="align-top text-sm">{keyRecord.label ?? '—'}</TableCell>
      <TableCell className="text-muted-foreground align-top text-xs">
        {formatRelative(keyRecord.createdAt)}
      </TableCell>
      <TableCell className="text-muted-foreground align-top text-xs">
        {keyRecord.lastUsedAt ? formatRelative(keyRecord.lastUsedAt) : 'Never'}
        {keyRecord.lastUsedIp ? ` · ${keyRecord.lastUsedIp}` : ''}
      </TableCell>
      <TableCell className="text-muted-foreground align-top text-xs">
        {keyRecord.expiresAt ? formatRelative(keyRecord.expiresAt) : 'No expiry'}
      </TableCell>
      <TableCell className="align-top">
        {keyRecord.revokedAt ? (
          <Badge variant="destructive">Revoked</Badge>
        ) : expired ? (
          <Badge variant="secondary">Expired</Badge>
        ) : (
          <Badge variant="secondary">Active</Badge>
        )}
      </TableCell>
      <TableCell className="align-top text-right">
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
      </TableCell>
    </TableRow>
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
                    {client.isActive ? null : <Badge variant="destructive">Revoked</Badge>}
                  </CardTitle>
                  {client.description ? (
                    <p className="text-muted-foreground text-sm">{client.description}</p>
                  ) : null}
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
              <CardContent className="space-y-5">
                {/* Every value gets a label. The badges this replaces read
                    "Test" and "Signed" with nothing saying what they described,
                    and ran the rate limit and the address rule together into one
                    sentence, so a reader could not tell which value was which. */}
                <div>
                  <SectionHeader title="Configuration" />
                  <Table className="mt-1">
                    <TableBody>
                      <TableRow>
                        <TableHead className="w-56 align-top">Environment</TableHead>
                        <TableCell>
                          <Badge variant={client.environment === 'LIVE' ? 'default' : 'secondary'}>
                            {client.environment === 'LIVE' ? 'Live' : 'Test'}
                          </Badge>
                          <span className="text-muted-foreground ml-2 text-xs">
                            Keys begin{' '}
                            <code className="text-xs">trk_{client.environment.toLowerCase()}_</code>
                          </span>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead className="align-top">Request signing</TableHead>
                        <TableCell className="text-sm">
                          {client.requireSignature ? (
                            <>
                              Required — must also send{' '}
                              <code className="text-xs">x-timestamp</code> and{' '}
                              <code className="text-xs">x-signature</code>
                            </>
                          ) : (
                            'Not required — reads only'
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead className="align-top">Permissions</TableHead>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {client.permissions.length ? (
                              client.permissions.map((permission) => (
                                <Badge key={permission} variant="secondary">
                                  {formatPermission(permission)}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-warning text-sm">
                                None — this client can reach nothing
                              </span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead className="align-top">Rate limit</TableHead>
                        <TableCell className="text-sm tabular-nums">
                          {client.rateLimitPerMinute} requests/minute, across every key
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead className="align-top">Allowed addresses</TableHead>
                        <TableCell className="text-sm">
                          {client.allowedIps.length ? client.allowedIps.join(', ') : 'Any address'}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>

                <SectionHeader
                  description="The Key ID is the public half — paste it into the API reference. The secret is shown only once, when the key is issued."
                  title="Keys"
                />
                {client.keys.length ? (
                  <Table className="mt-1">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key ID (public)</TableHead>
                        <TableHead>Label</TableHead>
                        <TableHead>Issued</TableHead>
                        <TableHead>Last used</TableHead>
                        <TableHead>Expires</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {client.keys.map((keyRecord) => (
                        <KeyRow
                          clientId={client.id}
                          environment={client.environment}
                          key={keyRecord.id}
                          keyRecord={keyRecord}
                          onRevoke={(input) => revokeKey.mutate(input)}
                        />
                      ))}
                    </TableBody>
                  </Table>
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
