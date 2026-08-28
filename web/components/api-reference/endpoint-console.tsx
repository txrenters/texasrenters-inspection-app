'use client';

import type { ApiDocument, ApiOperation } from '@texasrenters/shared';
import { AlertTriangleIcon, PlayIcon, RotateCcwIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  CredentialFields,
  apiKeyHeaderValue,
  credentialProblem,
  type Credential,
} from '@/components/api-reference/credential-fields';
import { JsonView } from '@/components/api-reference/json-view';
import { resolveSchema, schemaSkeleton, schemaTypeLabel } from '@/components/api-reference/schema-view';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { apiRawRequest, type RawApiResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Methods that change something.
 *
 * `DELETE` is separated out below rather than lumped in here: an accidental
 * POST usually leaves a spare record behind, while an accidental DELETE on this
 * system removes an inspection and its media with no restore.
 */
const WRITE_METHODS = new Set(['post', 'put', 'patch']);

/** Response headers worth surfacing above the body rather than in the full list. */
const HIGHLIGHTED_HEADERS = [
  'x-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
];

function statusTone(status: number) {
  if (status >= 500) return 'text-destructive';
  if (status >= 400) return 'text-warning';
  if (status >= 200 && status < 300) return 'text-success';
  return 'text-muted-foreground';
}

/**
 * Run one endpoint and read what came back.
 *
 * The request goes out on the operator's **own session**, not on a credential
 * this page holds — so it can do exactly what they could already do through the
 * rest of the console, enforced by the same guards, and appears in the audit
 * trail under their name. That is the property that makes an executable
 * reference safe to ship at all, and it is why there is no key field here.
 *
 * What it does not remove is the ordinary danger of a live system: this is
 * production data, and a write is a real write. Hence the arming step below.
 */
export function EndpointConsole({
  document,
  method,
  operation,
  path,
}: {
  document: ApiDocument | undefined;
  method: string;
  operation: ApiOperation;
  path: string;
}) {
  const isWrite = WRITE_METHODS.has(method);
  const isDelete = method === 'delete';
  const mutates = isWrite || isDelete;

  const pathParameters = useMemo(
    () => (operation.parameters ?? []).filter((parameter) => parameter.in === 'path'),
    [operation],
  );
  const queryParameters = useMemo(
    () => (operation.parameters ?? []).filter((parameter) => parameter.in === 'query'),
    [operation],
  );
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;

  const [credential, setCredential] = useState<Credential>({ keyId: '', secret: '' });
  const [attempted, setAttempted] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [body, setBody] = useState('');
  const [armed, setArmed] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RawApiResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Everything except the credential resets when the reader moves to another
  // endpoint. Carrying a half-filled body or — far worse — an armed write across
  // that switch is how someone sends the previous endpoint's payload to this
  // one. The key is deliberately kept: it identifies the integration being
  // tested, and re-pasting a secret for every endpoint invites storing it
  // somewhere worse.
  useEffect(() => {
    setValues({});
    setAttempted(false);
    setArmed(false);
    setConfirmation('');
    setResult(null);
    setFailure(null);
    setBody(bodySchema ? JSON.stringify(schemaSkeleton(bodySchema, document), null, 2) : '');
  }, [bodySchema, document, method, path]);

  const missingPathParameter = pathParameters.find((parameter) => !values[parameter.name]?.trim());
  const credentialFault = credentialProblem(credential);

  const resolvedPath = () => {
    let target = path;
    for (const parameter of pathParameters)
      target = target.replace(
        `{${parameter.name}}`,
        encodeURIComponent(values[parameter.name]?.trim() ?? ''),
      );
    const search = new URLSearchParams();
    for (const parameter of queryParameters) {
      const value = values[parameter.name]?.trim();
      if (value) search.set(parameter.name, value);
    }
    const query = search.toString();
    return query ? `${target}?${query}` : target;
  };

  // A credential fault deliberately does NOT disable the button. Disabling it
  // leaves someone with a dead control and no reason given — pressing Send is
  // how you find out which half is missing, so Send has to stay pressable.
  const canSend =
    !running &&
    !missingPathParameter &&
    (!mutates || armed) &&
    (!isDelete || confirmation.trim().toUpperCase() === 'DELETE');

  /** The headers the request will carry, shown before it is sent. */
  const requestHeaders = () => ({
    'x-api-key': credentialFault
      ? `${credential.keyId.trim() || '<key id>'}.${credential.secret.trim() ? '…' : '<secret>'}`
      : apiKeyHeaderValue(credential),
    'content-type': 'application/json',
  });

  const send = async () => {
    setAttempted(true);
    // Refused here rather than sent to earn a 401: the API would answer
    // API_KEY_MISSING or API_KEY_INVALID, which is a slower way of learning
    // something this page already knows.
    if (credentialFault) return;
    setRunning(true);
    setFailure(null);
    try {
      setResult(
        await apiRawRequest(resolvedPath(), {
          method: method.toUpperCase(),
          headers: { 'x-api-key': apiKeyHeaderValue(credential) },
          ...(mutates && body.trim() ? { body } : {}),
        }),
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The request could not be sent.');
    } finally {
      setRunning(false);
      // Disarmed after every send, so a second click cannot repeat a write that
      // was armed for one.
      setArmed(false);
      setConfirmation('');
    }
  };

  return (
    <div className="space-y-4">
      <CredentialFields
        credential={credential}
        onChange={setCredential}
        problem={credentialFault}
        showProblem={attempted}
      />

      {pathParameters.length > 0 || queryParameters.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[...pathParameters, ...queryParameters].map((parameter) => {
            const schema = resolveSchema(parameter.schema, document);
            return (
              <Field key={`${parameter.in}-${parameter.name}`}>
                <FieldLabel htmlFor={`parameter-${parameter.name}`}>
                  {parameter.name}
                  {parameter.in === 'path' ? (
                    <Badge className="ml-1.5" variant="secondary">
                      path
                    </Badge>
                  ) : null}
                </FieldLabel>
                <Input
                  id={`parameter-${parameter.name}`}
                  onChange={(event) =>
                    setValues({ ...values, [parameter.name]: event.target.value })
                  }
                  placeholder={schemaTypeLabel(parameter.schema, document)}
                  value={values[parameter.name] ?? ''}
                />
                {parameter.description || schema?.enum?.length ? (
                  <FieldDescription>
                    {parameter.description}
                    {schema?.enum?.length ? ` One of: ${schema.enum.join(', ')}.` : ''}
                  </FieldDescription>
                ) : null}
              </Field>
            );
          })}
        </div>
      ) : null}

      {mutates ? (
        <Field>
          <FieldLabel htmlFor="request-body">Request body</FieldLabel>
          <Textarea
            className="font-mono text-xs"
            id="request-body"
            onChange={(event) => setBody(event.target.value)}
            rows={10}
            spellCheck={false}
            value={body}
          />
          <FieldDescription>
            Prefilled from the schema with empty values, not with sample data — every field here is
            yours to fill in.
          </FieldDescription>
        </Field>
      ) : null}

      {/* The request as it will actually be sent, headers included. An
          integrator's first question is "what do I send", and a path alone does
          not answer it. */}
      <div className="bg-muted/40 space-y-1 rounded-md border p-3">
        <p className="text-muted-foreground mb-1 text-xs">Request</p>
        <p className="font-mono text-xs break-all">
          <span className="text-foreground font-semibold uppercase">{method}</span>{' '}
          {resolvedPath()}
        </p>
        {Object.entries(requestHeaders()).map(([name, value]) => (
          <p className="font-mono text-xs break-all" key={name}>
            <span className="text-muted-foreground">{name}:</span> {value}
          </p>
        ))}
      </div>

      {mutates ? (
        <Alert variant={isDelete ? 'destructive' : 'warning'}>
          <AlertTriangleIcon aria-hidden />
          <AlertTitle>
            {isDelete ? 'This deletes live data' : 'This writes to live data'}
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              The request runs against this environment with your own permissions and is recorded in
              the audit trail under your name. There is no sandbox behind this button.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={armed} onCheckedChange={(next) => setArmed(next === true)} />
              I understand this is a real {method.toUpperCase()} against live data.
            </label>
            {isDelete ? (
              <Input
                aria-label="Type DELETE to confirm"
                autoComplete="off"
                className="max-w-48"
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder="Type DELETE"
                value={confirmation}
              />
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!canSend} onClick={() => void send()}>
          {running ? <Spinner aria-hidden /> : <PlayIcon aria-hidden />}
          Send request
        </Button>
        {result ? (
          <Button onClick={() => setResult(null)} variant="ghost">
            <RotateCcwIcon aria-hidden />
            Clear
          </Button>
        ) : null}
        {/* A pointer, not a repeat. The specific fault is stated beside the
            field it belongs to; saying the same sentence twice is noise, and
            leaves the reader unsure whether it is one problem or two. */}
        {attempted && credentialFault ? (
          <p className="text-destructive text-sm">Check the credentials above.</p>
        ) : null}
        {missingPathParameter ? (
          <p className="text-muted-foreground text-sm">
            Fill in <span className="font-mono text-xs">{missingPathParameter.name}</span> to send.
          </p>
        ) : null}
      </div>

      {failure ? (
        <Alert variant="destructive">
          <AlertTriangleIcon aria-hidden />
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}

      {result ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className={cn('font-mono text-sm font-semibold', statusTone(result.status))}>
              {result.status} {result.statusText}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {result.durationMs} ms
            </span>
            {HIGHLIGHTED_HEADERS.filter((name) => result.headers[name]).map((name) => (
              <Badge key={name} variant="secondary">
                {name}: {result.headers[name]}
              </Badge>
            ))}
          </div>
          {result.text === undefined ? (
            <JsonView value={result.body} />
          ) : (
            <pre className="bg-muted/40 max-h-96 overflow-auto rounded-md border p-3 font-mono text-xs">
              {result.text || '(empty response)'}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}
