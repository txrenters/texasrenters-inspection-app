'use client';

import { useState, type FormEvent } from 'react';

import { CheckboxCard } from '@/components/checkbox-card';
import { CredentialResult } from '@/components/credential-result';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAccessMutations, useRoles } from '@/lib/queries';

export function UserCreateDialog({ onClose }: { onClose: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set());
  const create = useAccessMutations().createUser;
  const roles = useRoles({ page: 1, pageSize: 100 });

  function toggleRole(id: string) {
    setRoleIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await create.mutateAsync({
        displayName: displayName.trim(),
        email: email.trim(),
        roleIds: [...roleIds],
      });
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  const result = create.data;
  const delivered = result?.emailDeliveryStatus === 'SENT';

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{result ? 'User created' : 'Create user'}</DialogTitle>
          <DialogDescription>
            {result
              ? delivered
                ? 'Their sign-in details have been emailed to them.'
                : 'Email delivery was unavailable. Share these credentials privately.'
              : 'Their sign-in details and a one-time temporary password are emailed automatically. Access is defined entirely by the roles you assign.'}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <CredentialResult
            delivered={delivered}
            displayName={result.displayName}
            email={result.email}
            onDone={onClose}
            subjectLabel="User"
            temporaryPassword={result.temporaryPassword}
          />
        ) : (
          <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="user-name">Full name</FieldLabel>
                <Input
                  autoComplete="name"
                  autoFocus
                  id="user-name"
                  maxLength={120}
                  minLength={2}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="e.g. Jordan Ramirez"
                  required
                  value={displayName}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="user-email">Work email</FieldLabel>
                <Input
                  autoComplete="email"
                  id="user-email"
                  maxLength={254}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="user@company.com"
                  required
                  type="email"
                  value={email}
                />
              </Field>
            </div>

            <Field>
              <FieldLabel asChild>
                <span>Roles</span>
              </FieldLabel>
              <FieldDescription>
                Select at least one administrator-defined role. The account receives only the
                permissions granted by the roles selected here.
              </FieldDescription>
              <div className="-mx-1 max-h-[38vh] overflow-y-auto px-1">
                {roles.isLoading ? (
                  <div className="grid gap-2">
                    {Array.from({ length: 3 }, (_, index) => (
                      <Skeleton className="h-14 rounded-lg" key={index} />
                    ))}
                  </div>
                ) : roles.data?.items.length ? (
                  <div className="grid gap-2">
                    {roles.data.items.map((role) => (
                      <CheckboxCard
                        checked={roleIds.has(role.id)}
                        description={
                          role.description ??
                          `${role.permissions.length} permission${role.permissions.length === 1 ? '' : 's'}`
                        }
                        key={role.id}
                        onCheckedChange={() => toggleRole(role.id)}
                        title={role.name}
                      />
                    ))}
                  </div>
                ) : (
                  <Alert variant="warning">
                    <AlertDescription>
                      No roles exist yet. Create a role before provisioning a user - an account with
                      no role can sign in and reach nothing.
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            </Field>

            {create.error ? (
              <Alert variant="destructive">
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button disabled={create.isPending} onClick={onClose} type="button" variant="outline">
                Cancel
              </Button>
              <Button
                disabled={
                  create.isPending || !displayName.trim() || !email.trim() || roleIds.size === 0
                }
                type="submit"
              >
                {create.isPending ? <Spinner /> : null}
                {create.isPending ? 'Creating…' : 'Create user'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
