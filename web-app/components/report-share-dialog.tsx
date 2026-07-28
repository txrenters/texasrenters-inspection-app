'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { buttonVariants } from '@/components/ui/button';
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

import { useAdminMutations, useReportShares } from '@/lib/queries';
import type { AdminReportShare } from '@texasrenters/shared';

import { Badge, ErrorState, LoadingState, formatDate } from './shared';

function shareUrl(share: AdminReportShare) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}${share.sharePath}`;
}

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
  const mailto = share.recipientEmail
    ? `mailto:${encodeURIComponent(share.recipientEmail)}?subject=${encodeURIComponent(
        'Your TexasRenters inspection report',
      )}&body=${encodeURIComponent(
        `Hello,\n\nYour inspection report is ready to view:\n${url}\n\nThis link expires ${new Date(share.expiresAt).toLocaleDateString()}.`,
      )}`
    : null;

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <li className="share-row">
      <div className="share-row-info">
        <div className="share-row-head">
          <Badge value={state} />
          <span className="text-[13px] text-muted-foreground">
            {share.recipientEmail ?? 'No email supplied'} · created {formatDate(share.createdAt)} ·
            expires {formatDate(share.expiresAt)}
          </span>
        </div>
        <code className="share-url">{url}</code>
      </div>
      <div className="action-row">
        {state === 'ACTIVE' ? (
          <>
            <button type="button" className={buttonVariants({ variant: 'secondary' })} onClick={() => void copy()}>
              {copied ? 'Copied!' : 'Copy link'}
            </button>
            {mailto ? (
              <a className={buttonVariants({ variant: 'secondary' })} href={mailto}>
                Email link
              </a>
            ) : null}
            <button
              type="button"
              className={buttonVariants({ variant: 'danger' })}
              disabled={revokeReportShare.isPending}
              onClick={() => revokeReportShare.mutate({ id: share.id, inspectionId })}
            >
              Revoke
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}

export function ReportShareDialog({
  inspectionId,
  onClose,
}: {
  inspectionId: string;
  onClose: () => void;
}) {
  const [email, setEmail] = useState('');
  const shares = useReportShares(inspectionId);
  const { createReportShare } = useAdminMutations();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await createReportShare.mutateAsync({
      inspectionId,
      recipientEmail: email.trim() || undefined,
    });
    setEmail('');
  }

  return (
    <Sheet open onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent side="right" className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Share inspection report</SheetTitle>
          <SheetDescription>
            Anyone with a link can view a read-only report of this inspection: room status and
            findings that a reviewer approved. Internal notes and pending AI output are never
            included. Links expire after 30 days and can be revoked at any time.
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="grid gap-4">
      <form onSubmit={(event) => void submit(event)} className="share-create-form">
        <Field className="min-w-60 flex-1">
          <FieldLabel htmlFor="report-share-email">Homeowner email (optional)</FieldLabel>
          <Input
            id="report-share-email"
            type="email"
            placeholder="owner@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <button className={buttonVariants({ variant: 'primary' })} disabled={createReportShare.isPending}>
          {createReportShare.isPending ? 'Creating…' : 'Create link'}
        </button>
      </form>
      {createReportShare.error ? (
        <FieldError>{createReportShare.error.message}</FieldError>
      ) : null}
      {createReportShare.data?.emailDeliveryStatus ? (
        <div
          className={`alert ${
            createReportShare.data.emailDeliveryStatus === 'SENT'
              ? 'alert-success'
              : 'alert-warning'
          }`}
          role="status"
        >
          {createReportShare.data.emailDeliveryStatus === 'SENT'
            ? 'The report link was emailed successfully.'
            : 'The report link was created, but email delivery was unavailable. You can still copy the link below.'}
        </div>
      ) : null}
      {shares.isLoading ? (
        <LoadingState label="Loading report links…" />
      ) : shares.isError ? (
        <ErrorState error={shares.error} retry={() => void shares.refetch()} />
      ) : shares.data?.length ? (
        <ul className="share-list">
          {shares.data.map((share) => (
            <ShareRow key={share.id} share={share} inspectionId={inspectionId} />
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted-foreground">No report links have been created for this inspection yet.</p>
      )}
        </SheetBody>
        <SheetFooter>
          <SheetClose className={buttonVariants({ variant: 'secondary' })}>Close</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
