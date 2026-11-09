'use client';

import { MAX_STATEMENT_DISCLAIMER, type StatementSettingsView } from '@texasrenters/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { useSaveStatementSettings, useStatementSettings } from '@/lib/property-account-queries';

/**
 * Jobber's statement settings (2026-11-10, phase 3 of the invoice gap
 * review): the billing history newest first or oldest first, and the text at
 * the foot of every statement.
 */
export function StatementSettingsSection({ mayChange }: { mayChange: boolean }) {
  const settings = useStatementSettings();
  if (settings.isLoading || !settings.data) return null;
  return <StatementForm key={settings.data.updatedAt ?? 'never'} mayChange={mayChange} view={settings.data} />;
}

function StatementForm({ view, mayChange }: { view: StatementSettingsView; mayChange: boolean }) {
  const id = useId();
  const save = useSaveStatementSettings();
  const [newestFirst, setNewestFirst] = useState(view.newestFirst);
  const [disclaimer, setDisclaimer] = useState(view.disclaimer ?? '');
  const dirty = newestFirst !== view.newestFirst || (disclaimer.trim() || null) !== view.disclaimer;

  const submit = () =>
    save.mutate(
      { newestFirst, disclaimer: disclaimer.trim() || null, expectedUpdatedAt: view.updatedAt },
      {
        onSuccess: () => toast.success('Statement settings saved'),
        onError: (error) =>
          toast.error('Nothing was saved', {
            description: error instanceof ApiError && error.status === 409 ? `${error.message} The page now shows them as they are.` : error.message,
          }),
      },
    );

  return (
    <section aria-label="Statements" className="bg-card mt-6 rounded-lg border p-4">
      <h2 className="text-heading text-lg font-bold">Statements</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        A property&apos;s billing history, downloaded or emailed from its page.
      </p>
      <div className="mt-4 grid gap-4">
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Sort order of billing history</legend>
          {[
            { value: true, label: 'Newest first' },
            { value: false, label: 'Oldest first' },
          ].map((option) => (
            <label className="flex items-center gap-2 text-sm" key={option.label}>
              <input
                checked={newestFirst === option.value}
                className="accent-primary size-4"
                disabled={!mayChange}
                name={`${id}-order`}
                onChange={() => setNewestFirst(option.value)}
                type="radio"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <Field>
          <FieldLabel htmlFor={`${id}-disclaimer`}>Contract / disclaimer</FieldLabel>
          <Textarea
            className="min-h-20"
            disabled={!mayChange}
            id={`${id}-disclaimer`}
            maxLength={MAX_STATEMENT_DISCLAIMER}
            onChange={(event) => setDisclaimer(event.target.value)}
            value={disclaimer}
          />
          <FieldDescription>Printed at the foot of every statement.</FieldDescription>
        </Field>
      </div>
      {mayChange ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
          <p aria-live="polite" className="text-muted-foreground text-sm">
            {dirty ? 'Not saved yet.' : ''}
          </p>
          <Button disabled={!dirty || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save statement settings'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
