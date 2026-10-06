'use client';

import type { AdminReportShare, ReportShareKind } from '@texasrenters/shared';
import { CheckIcon, CopyIcon, MailIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { formatDate } from '@/lib/format';
import { useAdminMutations, useReportShares } from '@/lib/queries';

function shareUrl(share: AdminReportShare) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}${share.sharePath}`;
}

/**
 * How each document's links are offered. The comparison goes to owners and
 * tenants to review (the office, 2026-10-06); the inspection report to the
 * homeowner, as it always has.
 */
const COPY: Record<
  ReportShareKind,
  { title: string; description: string; recipient: string; subject: string; body: string; empty: string }
> = {
  INSPECTION: {
    title: 'Share inspection report',
    description:
      'Anyone with a link can view a read-only report of this inspection: room status and findings that a reviewer approved. Internal notes and pending AI output are never included. Links expire after 30 days and can be revoked at any time.',
    recipient: 'Homeowner email (optional)',
    subject: 'Your TexasRenters inspection report',
    body: 'Your inspection report is ready to view',
    empty: 'No report links have been created for this inspection yet.',
  },
  COMPARISON: {
    title: 'Share comparison report',
    description:
      'Anyone with a link can view the approved move-in / move-out comparison: each room at both inspections, item by item, with the photographs and findings a reviewer approved. Internal notes, the AI’s notes and pending AI output are never included. If the comparison is changed and returns to review, its links show “being updated” until it is approved again. Links expire after 30 days and can be revoked at any time.',
    recipient: 'Owner or tenant email (optional)',
    subject: 'Your TexasRenters move-in / move-out comparison report',
    body: 'Your move-in / move-out comparison report is ready to view',
    empty: 'No links have been created for this comparison yet.',
  },
};

function shareState(share: AdminReportShare) {
  if (share.revokedAt) return 'REVOKED';
  if (new Date(share.expiresAt) < new Date()) return 'EXPIRED';
  return 'ACTIVE';
}

function ShareRow({ share, inspectionId }: { share: AdminReportShare; inspectionId: string }) {
  const { revokeReportShare } = useAdminMutations();
  const [copied, setCopied] = useState(false);
  const state = shareState(share);
  const url = shareUrl(share);
  const copy = COPY[share.kind ?? 'INSPECTION'];
  const mailto = share.recipientEmail
    ? `mailto:${encodeURIComponent(share.recipientEmail)}?subject=${encodeURIComponent(
        copy.subject,
      )}&body=${encodeURIComponent(
        `Hello,\n\n${copy.body}:\n${url}\n\nThis link expires ${formatDate(share.expiresAt)}.`,
      )}`
    : null;

  async function copyLink() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge value={state} />
        <span className="text-muted-foreground text-xs">
          {share.recipientEmail ?? 'No email supplied'} · created {formatDate(share.createdAt)} ·
          expires {formatDate(share.expiresAt)}
        </span>
      </div>

      <code className="bg-muted block rounded px-2 py-1.5 text-xs break-all">{url}</code>

      {state === 'ACTIVE' ? (
        <div className="flex flex-wrap gap-1.5">
          <Button onClick={() => void copyLink()} size="sm" type="button" variant="outline">
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          {mailto ? (
            <Button asChild size="sm" variant="outline">
              <a href={mailto}>
                <MailIcon />
                Email link
              </a>
            </Button>
          ) : null}
          <Button
            className="text-destructive hover:bg-destructive/10 hover:text-destructive ml-auto"
            disabled={revokeReportShare.isPending}
            onClick={() => revokeReportShare.mutate({ id: share.id, inspectionId })}
            size="sm"
            type="button"
            variant="ghost"
          >
            Revoke
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function ReportShareDialog({
  inspectionId,
  onClose,
  kind = 'INSPECTION',
}: {
  inspectionId: string;
  onClose: () => void;
  /** Which document to share: the inspection's report, or a move-out's comparison. */
  kind?: ReportShareKind;
}) {
  const [email, setEmail] = useState('');
  const shares = useReportShares(inspectionId, kind);
  const { createReportShare } = useAdminMutations();
  const copy = COPY[kind];

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await createReportShare.mutateAsync({
        inspectionId,
        recipientEmail: email.trim() || undefined,
        kind,
      });
      setEmail('');
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  return (
    <Sheet onOpenChange={(next) => (next ? undefined : onClose())} open>
      <SheetContent className="w-full sm:max-w-lg" side="right">
        <SheetHeader>
          <SheetTitle>{copy.title}</SheetTitle>
          <SheetDescription>{copy.description}</SheetDescription>
        </SheetHeader>

        <SheetBody className="space-y-4">
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void submit(event)}>
            <Field className="min-w-[200px] flex-1">
              <FieldLabel htmlFor="report-share-email">{copy.recipient}</FieldLabel>
              <Input
                id="report-share-email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="owner@example.com"
                type="email"
                value={email}
              />
            </Field>
            <Button disabled={createReportShare.isPending} type="submit">
              {createReportShare.isPending ? <Spinner /> : null}
              {createReportShare.isPending ? 'Creating…' : 'Create link'}
            </Button>
          </form>

          {createReportShare.error ? (
            <Alert variant="destructive">
              <AlertDescription>{createReportShare.error.message}</AlertDescription>
            </Alert>
          ) : null}

          {createReportShare.data?.emailDeliveryStatus ? (
            <Alert
              variant={
                createReportShare.data.emailDeliveryStatus === 'SENT' ? 'success' : 'warning'
              }
            >
              <AlertDescription>
                {createReportShare.data.emailDeliveryStatus === 'SENT'
                  ? 'The report link was emailed successfully.'
                  : 'The report link was created, but email delivery was unavailable. You can still copy the link below.'}
              </AlertDescription>
            </Alert>
          ) : null}

          {shares.isLoading ? (
            <div className="grid gap-2">
              {Array.from({ length: 2 }, (_, index) => (
                <Skeleton className="h-28 rounded-lg" key={index} />
              ))}
            </div>
          ) : shares.isError ? (
            <ErrorState error={shares.error} retry={() => void shares.refetch()} />
          ) : shares.data?.length ? (
            <ul className="grid gap-2">
              {shares.data.map((share) => (
                <ShareRow inspectionId={inspectionId} key={share.id} share={share} />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
              {copy.empty}
            </p>
          )}
        </SheetBody>

        <SheetFooter>
          <SheetClose asChild>
            <Button variant="outline">Close</Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
