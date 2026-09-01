import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExecutionContext } from '@nestjs/common';

import { JobberWebhookGuard } from '../src/integrations/jobber/jobber-webhook.guard';
import { jobberWebhookSchema } from '../src/integrations/jobber/jobber.schemas';

const SECRET = 'test-client-secret';

const body = (topic = 'VISIT_UPDATE') =>
  JSON.stringify({
    data: {
      webHookEvent: {
        topic,
        appId: '3ef22a50-072d-430c-a78f-b7646657560b',
        accountId: 'MQ==',
        itemId: 'MTIz',
        occurredAt: '2026-09-02T10:00:00-06:00',
      },
    },
  });

const sign = (raw: string, secret = SECRET) =>
  createHmac('sha256', secret).update(Buffer.from(raw)).digest('base64');

const contextFor = (raw: string | undefined, signature?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        rawBody: raw === undefined ? undefined : Buffer.from(raw),
        header: (name: string) =>
          name.toLowerCase() === 'x-jobber-hmac-sha256' ? signature : undefined,
      }),
    }),
  }) as unknown as ExecutionContext;

describe('Jobber webhook signature', () => {
  const guard = new JobberWebhookGuard();
  const previous = process.env.JOBBER_CLIENT_SECRET;

  beforeEach(() => {
    process.env.JOBBER_CLIENT_SECRET = SECRET;
  });
  afterAll(() => {
    process.env.JOBBER_CLIENT_SECRET = previous;
  });

  it('accepts a body signed with the app client secret', () => {
    const raw = body();
    expect(guard.canActivate(contextFor(raw, sign(raw)))).toBe(true);
  });

  it('rejects a body that was altered after signing', () => {
    // The whole point: this endpoint decides that a visit changed, which turns
    // into inspections appearing and moving.
    const raw = body();
    const signature = sign(raw);
    const tampered = raw.replace('MTIz', 'OTk5');
    expect(() => guard.canActivate(contextFor(tampered, signature))).toThrow(/signature/i);
  });

  it('rejects a signature made with a different secret', () => {
    const raw = body();
    expect(() => guard.canActivate(contextFor(raw, sign(raw, 'someone-elses-secret')))).toThrow(
      /signature/i,
    );
  });

  it('rejects a signature of the wrong length without throwing on the compare', () => {
    // timingSafeEqual throws on unequal lengths rather than returning false, so
    // a short signature must be caught before it reaches the comparison or a
    // bad signature becomes a 500.
    const raw = body();
    expect(() => guard.canActivate(contextFor(raw, 'short'))).toThrow(/signature is invalid/i);
  });

  it('refuses when no signature is sent at all', () => {
    expect(() => guard.canActivate(contextFor(body(), undefined))).toThrow(/missing/i);
  });

  it('refuses rather than passing through when the secret is not configured', () => {
    // An unverified endpoint that creates inspections is worse than one that is
    // switched off, in every environment.
    delete process.env.JOBBER_CLIENT_SECRET;
    const raw = body();
    expect(() => guard.canActivate(contextFor(raw, sign(raw)))).toThrow(/not configured/i);
  });

  it('refuses when the raw body was not preserved', () => {
    // Re-serializing the parsed body would not reproduce key order or
    // whitespace, so every genuine signature would fail and look like a wrong
    // secret. Better to say the body is unverifiable.
    expect(() => guard.canActivate(contextFor(undefined, 'anything'))).toThrow(
      /could not be verified/i,
    );
  });
});

describe('Jobber webhook payload', () => {
  it('parses the documented shape', () => {
    const parsed = jobberWebhookSchema.safeParse(JSON.parse(body('VISIT_CREATE')));
    expect(parsed.success).toBe(true);
  });

  it('accepts the legacy misspelled timestamp', () => {
    // Apps created before 8 December 2023 receive `occuredAt`. Ours is new, but
    // the cost of accepting both is one optional field and the failure mode is
    // a silent one.
    const legacy = {
      data: {
        webHookEvent: { topic: 'VISIT_UPDATE', accountId: 'MQ==', itemId: 'MTIz', occuredAt: 'x' },
      },
    };
    expect(jobberWebhookSchema.safeParse(legacy).success).toBe(true);
  });

  it('rejects a payload with no item to act on', () => {
    const missing = { data: { webHookEvent: { topic: 'VISIT_UPDATE', accountId: 'MQ==' } } };
    expect(jobberWebhookSchema.safeParse(missing).success).toBe(false);
  });
});

describe('the topics the handler acts on', () => {
  const SERVICE = readFileSync(
    join(__dirname, '..', 'src', 'integrations', 'jobber', 'jobber.webhook.service.ts'),
    'utf8',
  );

  it('uses the exact topic names Jobber offers', () => {
    // Confirmed against the Developer Center dropdown, not inferred from the
    // OBJECT_ACTION convention. A near-miss here is silent: the delivery is
    // verified and recorded, then acted on by nothing.
    for (const topic of ['VISIT_CREATE', 'VISIT_UPDATE', 'VISIT_COMPLETE', 'VISIT_DESTROY', 'APP_DISCONNECT'])
      expect(SERVICE).toContain(`'${topic}'`);
  });

  it('handles VISIT_DESTROY separately from the fetch-and-process topics', () => {
    // A deleted visit and a visit we cannot see both return nothing, so only
    // the topic distinguishes them. Routing destroy through syncVisit would
    // leave the inspection scheduled for work that no longer exists.
    expect(SERVICE).toMatch(/VISIT_TOPICS = new Set\(\['VISIT_CREATE', 'VISIT_UPDATE', 'VISIT_COMPLETE'\]\)/);
    expect(SERVICE).toMatch(/topic === 'VISIT_DESTROY'/);
  });

  it('never cancels work a technician has already started', () => {
    expect(SERVICE).toMatch(/inspection\.startedAt \|\| inspection\.status !== InspectionStatus\.SCHEDULED/);
    expect(SERVICE).toContain('JOBBER_VISIT_DELETED_NEEDS_REVIEW');
  });
});
