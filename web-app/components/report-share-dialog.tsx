'use client';

import { useEffect, useRef, useState } from 'react';

import { useAdminMutations, useReportShares } from '@/lib/queries';
import type { AdminReportShare } from '@texasrenters/shared';

import { Badge, ErrorState, LoadingState, formatDate } from './ui';

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
          <span className="media-meta">
            {share.recipientEmail ?? 'No email supplied'} · created {formatDate(share.createdAt)} ·
            expires {formatDate(share.expiresAt)}
          </span>
        </div>
        <code className="share-url">{url}</code>
      </div>
      <div className="action-row">
        {state === 'ACTIVE' ? (
          <>
            <button type="button" className="button button-secondary" onClick={() => void copy()}>
              {copied ? 'Copied!' : 'Copy link'}
            </button>
            {mailto ? (
              <a className="button button-secondary" href={mailto}>
                Email link
              </a>
            ) : null}
            <button
              type="button"
              className="button button-danger"
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
  const ref = useRef<HTMLDialogElement>(null);
  const [email, setEmail] = useState('');
  const shares = useReportShares(inspectionId);
  const { createReportShare } = useAdminMutations();

  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await createReportShare.mutateAsync({
      inspectionId,
      recipientEmail: email.trim() || undefined,
    });
    setEmail('');
  }

  return (
    <dialog ref={ref} className="dialog dialog-wide" onCancel={onClose} onClose={onClose}>
      <h2>Share inspection report</h2>
      <p>
        Anyone with a link can view a read-only report of this inspection: room status and
        findings that a reviewer approved. Internal notes and pending AI output are never
        included. Links expire after 30 days and can be revoked at any time.
      </p>
      <form onSubmit={(event) => void submit(event)} className="share-create-form">
        <div className="field share-email-field">
          <label htmlFor="report-share-email">Homeowner email (optional)</label>
          <input
            id="report-share-email"
            type="email"
            placeholder="owner@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <button className="button button-primary" disabled={createReportShare.isPending}>
          {createReportShare.isPending ? 'Creating…' : 'Create link'}
        </button>
      </form>
      {createReportShare.error ? (
        <p className="field-error">{createReportShare.error.message}</p>
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
        <p className="media-meta">No report links have been created for this inspection yet.</p>
      )}
      <div className="form-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
