'use client';

import { KeyRoundIcon } from 'lucide-react';

import { PasswordInput } from '@/components/password-input';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * The two halves of a key, as the console shows them.
 *
 * `trk_live_6b09d03ba1c2.<secret>` is one string on the wire, but it is two
 * things: an identifier that is safe to store, log and paste into a support
 * thread, and a secret that is none of those. Asking for them separately is
 * what makes that difference visible — an integrator who has only ever seen the
 * joined form has no reason to know half of it is safe to share.
 */
export const KEY_ID_PATTERN = /^trk_(live|test)_[\da-f]{12}$/;
export const KEY_SECRET_PATTERN = /^[\w-]{43}$/;

export interface Credential {
  keyId: string;
  secret: string;
}

export type CredentialProblem = 'keyId-missing' | 'keyId-malformed' | 'secret-missing' | 'secret-malformed';

/**
 * What is wrong with the pair, or null when it is usable.
 *
 * Both halves are required and neither is inferable from the other, so a
 * request is refused here rather than sent to earn a 401. The API would answer
 * `API_KEY_MISSING` or `API_KEY_INVALID`, which is a slower way of learning
 * something the page already knows.
 */
export function credentialProblem(credential: Credential): CredentialProblem | null {
  const keyId = credential.keyId.trim();
  const secret = credential.secret.trim();
  if (!keyId) return 'keyId-missing';
  if (!KEY_ID_PATTERN.test(keyId)) return 'keyId-malformed';
  if (!secret) return 'secret-missing';
  if (!KEY_SECRET_PATTERN.test(secret)) return 'secret-malformed';
  return null;
}

export const CREDENTIAL_PROBLEM_MESSAGE: Record<CredentialProblem, string> = {
  'keyId-missing': 'A key ID is required. Both halves of the key must be given.',
  'keyId-malformed': 'A key ID looks like trk_live_6b09d03ba1c2 — the part before the dot.',
  'secret-missing': 'A secret is required. Both halves of the key must be given.',
  'secret-malformed': 'A secret is 43 characters — the part after the dot.',
};

/** The header value the two halves combine into. */
export function apiKeyHeaderValue(credential: Credential) {
  return `${credential.keyId.trim()}.${credential.secret.trim()}`;
}

export function CredentialFields({
  credential,
  onChange,
  problem,
  showProblem,
}: {
  credential: Credential;
  onChange: (next: Credential) => void;
  problem: CredentialProblem | null;
  showProblem: boolean;
}) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <KeyRoundIcon aria-hidden className="size-4" />
        Integration credentials
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="credential-key-id">Key ID (public)</FieldLabel>
          <Input
            autoComplete="off"
            id="credential-key-id"
            onChange={(event) => onChange({ ...credential, keyId: event.target.value })}
            placeholder="trk_live_6b09d03ba1c2"
            spellCheck={false}
            value={credential.keyId}
          />
          <FieldDescription>
            The half before the dot. Safe to store and to share.
          </FieldDescription>
          {showProblem && problem?.startsWith('keyId') ? (
            <FieldError>{CREDENTIAL_PROBLEM_MESSAGE[problem]}</FieldError>
          ) : null}
        </Field>

        <Field>
          <FieldLabel htmlFor="credential-secret">Secret</FieldLabel>
          {/* Masked, never autofilled, and never persisted — this page holds it
              only until you leave. It is a live credential: anything you send
              here is done as that integration, not as you. */}
          <PasswordInput
            autoComplete="off"
            id="credential-secret"
            onChange={(event) => onChange({ ...credential, secret: event.target.value })}
            placeholder="the half after the dot"
            value={credential.secret}
          />
          <FieldDescription>Shown once when the key was issued.</FieldDescription>
          {showProblem && problem?.startsWith('secret') ? (
            <FieldError>{CREDENTIAL_PROBLEM_MESSAGE[problem]}</FieldError>
          ) : null}
        </Field>
      </div>
    </div>
  );
}
