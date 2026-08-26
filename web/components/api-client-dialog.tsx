'use client';

import type { ApiClientSummary } from '@texasrenters/shared';
import {
  MACHINE_FORBIDDEN_PERMISSIONS,
  PERMISSION_CATALOG,
  isMachineGrantablePermission,
} from '@texasrenters/shared';
import { ShieldAlertIcon } from 'lucide-react';
import { useState } from 'react';

import { CheckboxCard } from '@/components/checkbox-card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { ApiClientInput } from '@/lib/queries';

/** A permission that changes something, and therefore requires request signing. */
const isWrite = (permission: string) => !permission.endsWith(':read');

/**
 * Register or edit an integration.
 *
 * The permission list here is the machine-grantable subset, and the keys missing
 * from it are named explicitly rather than quietly absent — an operator looking
 * for `inspections:delete` should find out *why* it is not on offer instead of
 * concluding the page is broken.
 */
export function ApiClientDialog({
  client,
  onClose,
  onSubmit,
  open,
  pending,
}: {
  client?: ApiClientSummary | null;
  onClose: () => void;
  onSubmit: (input: ApiClientInput) => void;
  open: boolean;
  pending: boolean;
}) {
  const [name, setName] = useState(client?.name ?? '');
  const [description, setDescription] = useState(client?.description ?? '');
  const [environment, setEnvironment] = useState<'LIVE' | 'TEST'>(client?.environment ?? 'LIVE');
  const [permissions, setPermissions] = useState<Set<string>>(new Set(client?.permissions ?? []));
  const [rateLimit, setRateLimit] = useState(String(client?.rateLimitPerMinute ?? 60));
  const [requireSignature, setRequireSignature] = useState(client?.requireSignature ?? false);
  const [allowedIps, setAllowedIps] = useState((client?.allowedIps ?? []).join('\n'));

  const selectedWrites = [...permissions].filter(isWrite);
  // The same rule the API enforces, surfaced before the request rather than as a
  // 422 afterwards. It is enforced on the server regardless; this only means the
  // operator finds out while they can still act on it.
  const signatureRequired = selectedWrites.length > 0;
  const blocked = signatureRequired && !requireSignature;

  const submit = () => {
    onSubmit({
      name: name.trim(),
      description: description.trim() || undefined,
      environment,
      permissions: [...permissions],
      rateLimitPerMinute: Number(rateLimit) || 60,
      requireSignature,
      allowedIps: allowedIps
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean),
    });
  };

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={open}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>{client ? `Edit ${client.name}` : 'Register an API client'}</DialogTitle>
          <DialogDescription>
            An integration authenticates with a key you issue separately. Creating it here grants no
            credential on its own.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="client-name">Name</FieldLabel>
              <Input
                id="client-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="Owner portal sync"
                value={name}
              />
              <FieldDescription>What you will revoke it by, under pressure.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="client-environment">Environment</FieldLabel>
              <Select
                onValueChange={(value) => setEnvironment(value as 'LIVE' | 'TEST')}
                value={environment}
              >
                <SelectTrigger id="client-environment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LIVE">Live</SelectItem>
                  <SelectItem value="TEST">Test</SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>
                Carried in the key itself, so a key pasted into the wrong environment fails rather
                than writing.
              </FieldDescription>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="client-description">Description</FieldLabel>
            <Textarea
              id="client-description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Who runs it, and what it reads."
              rows={2}
              value={description}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="client-rate-limit">Requests per minute</FieldLabel>
              <Input
                id="client-rate-limit"
                inputMode="numeric"
                onChange={(event) => setRateLimit(event.target.value)}
                value={rateLimit}
              />
              <FieldDescription>Counted across every key this client holds.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="client-allowed-ips">Allowed addresses</FieldLabel>
              <Textarea
                id="client-allowed-ips"
                onChange={(event) => setAllowedIps(event.target.value)}
                placeholder="One per line. Leave empty to allow any."
                rows={2}
                value={allowedIps}
              />
              <FieldDescription>
                Only meaningful when TRUST_PROXY_HOPS matches the deployment.
              </FieldDescription>
            </Field>
          </div>

          <label className="flex items-start gap-3 rounded-lg border p-3">
            <Switch checked={requireSignature} onCheckedChange={setRequireSignature} />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">Require request signing</span>
              <span className="text-muted-foreground text-xs">
                The client sends an HMAC of the method, path, timestamp and body. Required for any
                write scope — it is what stops the same POST arriving twice.
              </span>
            </span>
          </label>

          <div className="space-y-2">
            <p className="text-sm font-medium">Permissions</p>
            {PERMISSION_CATALOG.map((group) => {
              const grantable = group.permissions.filter((permission) =>
                isMachineGrantablePermission(permission.key),
              );
              if (grantable.length === 0) return null;
              return (
                <div className="space-y-1.5" key={group.group}>
                  <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    {group.group}
                  </p>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {grantable.map((permission) => (
                      <CheckboxCard
                        checked={permissions.has(permission.key)}
                        description={permission.description}
                        key={permission.key}
                        onCheckedChange={(checked) => {
                          const next = new Set(permissions);
                          if (checked) next.add(permission.key);
                          else next.delete(permission.key);
                          setPermissions(next);
                        }}
                        title={permission.label}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <Alert>
            <ShieldAlertIcon aria-hidden />
            <AlertDescription>
              <p className="font-medium">Never available to a key</p>
              <p className="text-muted-foreground">
                {MACHINE_FORBIDDEN_PERMISSIONS.join(', ')} — these either let a credential grant
                itself more access, or destroy evidence with no way back. A person holding the
                permission may do them; a credential in someone else&apos;s configuration file may
                not.
              </p>
            </AlertDescription>
          </Alert>

          {blocked ? (
            <Alert variant="warning">
              <ShieldAlertIcon aria-hidden />
              <AlertDescription>
                {selectedWrites.join(', ')} {selectedWrites.length === 1 ? 'is a write' : 'are writes'}.
                Turn on request signing to grant {selectedWrites.length === 1 ? 'it' : 'them'}.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter className="px-6 pb-6">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={pending || blocked || name.trim().length < 2} onClick={submit}>
            {pending ? <Spinner aria-hidden /> : null}
            {client ? 'Save changes' : 'Register client'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
