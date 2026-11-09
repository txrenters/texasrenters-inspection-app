'use client';

import {
  MAX_TEMPLATE_MESSAGE,
  MAX_TEMPLATE_SUBJECT,
  TEMPLATE_KINDS,
  TEMPLATE_KIND_LABEL,
  TEMPLATE_PLACEHOLDERS,
  isEmailAddress,
  templateProblem,
  type EmailTemplates,
  type EmailTemplatesView,
  type TemplateKind,
} from '@texasrenters/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { useEmailTemplates, useSaveEmailTemplates } from '@/lib/invoice-record-queries';

/**
 * The office's words for the invoice, receipt and statement emails, and where
 * a client's reply goes (2026-11-10, phase 4 of the invoice gap review), as
 * Jobber's "Emails & Text Messages". Each email still carries the invoice,
 * the receipt or the statement under the words. Follow-ups keep Jobber's.
 */
export function EmailTemplatesSection({ mayChange }: { mayChange: boolean }) {
  const view = useEmailTemplates();
  if (view.isLoading || !view.data) return null;
  return <TemplatesForm key={view.data.updatedAt ?? 'never'} mayChange={mayChange} view={view.data} />;
}

function TemplatesForm({ view, mayChange }: { view: EmailTemplatesView; mayChange: boolean }) {
  const id = useId();
  const save = useSaveEmailTemplates();
  const [templates, setTemplates] = useState<EmailTemplates>(view.templates);
  const [replyTo, setReplyTo] = useState(view.replyTo ?? '');
  const [tab, setTab] = useState<TemplateKind>('invoice');

  const problem =
    TEMPLATE_KINDS.map((kind) => templateProblem(kind, templates[kind])).find(Boolean) ??
    (replyTo.trim() && !isEmailAddress(replyTo.trim()) ? 'Replies go to an email address.' : null);
  const dirty = JSON.stringify(templates) !== JSON.stringify(view.templates) || (replyTo.trim() || null) !== view.replyTo;

  const change = (kind: TemplateKind, field: 'subject' | 'message', value: string) =>
    setTemplates((current) => ({ ...current, [kind]: { ...current[kind], [field]: value } }));

  const submit = () =>
    save.mutate(
      { templates, replyTo: replyTo.trim() || null, expectedUpdatedAt: view.updatedAt },
      {
        onSuccess: () => toast.success('Email templates saved'),
        onError: (error) =>
          toast.error('Nothing was saved', {
            description: error instanceof ApiError && error.status === 409 ? `${error.message} The page now shows them as they are.` : error.message,
          }),
      },
    );

  return (
    <section aria-label="Email templates" className="bg-card mt-6 rounded-lg border p-4">
      <h2 className="text-heading text-lg font-bold">Email templates</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        The subject and the words at the top of each email. The invoice, receipt or statement itself comes under them.
      </p>

      <Tabs className="mt-4" onValueChange={(next) => setTab(next as TemplateKind)} value={tab}>
        <TabsList aria-label="Which email">
          {TEMPLATE_KINDS.map((kind) => (
            <TabsTrigger key={kind} value={kind}>
              {TEMPLATE_KIND_LABEL[kind]}
            </TabsTrigger>
          ))}
        </TabsList>
        {TEMPLATE_KINDS.map((kind) => (
          <TabsContent className="mt-3 grid gap-3" key={kind} value={kind}>
            <Field>
              <FieldLabel htmlFor={`${id}-${kind}-subject`}>Subject</FieldLabel>
              <Input
                disabled={!mayChange}
                id={`${id}-${kind}-subject`}
                maxLength={MAX_TEMPLATE_SUBJECT}
                onChange={(event) => change(kind, 'subject', event.target.value)}
                value={templates[kind].subject}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-${kind}-message`}>Message</FieldLabel>
              <Textarea
                className="min-h-32"
                disabled={!mayChange}
                id={`${id}-${kind}-message`}
                maxLength={MAX_TEMPLATE_MESSAGE}
                onChange={(event) => change(kind, 'message', event.target.value)}
                value={templates[kind].message}
              />
              <FieldDescription>
                Can say:{' '}
                {TEMPLATE_PLACEHOLDERS[kind].map((item, index) => (
                  <span key={item.key}>
                    {index ? ', ' : ''}
                    <code className="text-foreground">{`{{${item.key}}}`}</code> ({item.label.toLowerCase()})
                  </span>
                ))}
                .
              </FieldDescription>
            </Field>
          </TabsContent>
        ))}
      </Tabs>

      <Field className="mt-4 max-w-md">
        <FieldLabel htmlFor={`${id}-reply-to`}>Replies go to</FieldLabel>
        <Input
          disabled={!mayChange}
          id={`${id}-reply-to`}
          inputMode="email"
          maxLength={254}
          onChange={(event) => setReplyTo(event.target.value)}
          placeholder={view.companyEmail ?? 'the company email'}
          value={replyTo}
        />
        <FieldDescription>
          When a client answers an invoice, receipt, statement or follow-up. Blank sends replies to the company email
          {view.companyEmail ? ` (${view.companyEmail})` : ''}.
        </FieldDescription>
      </Field>

      {mayChange ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
          <p aria-live="polite" className={problem ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
            {problem ?? (dirty ? 'Not saved yet.' : '')}
          </p>
          <Button disabled={!dirty || Boolean(problem) || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save email templates'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
