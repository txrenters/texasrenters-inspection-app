import { ClientErrorsService, redact } from '../src/client-errors/client-errors.service';
import type { ReportClientErrorsDto } from '../src/client-errors/client-errors.dto';

/**
 * The endpoint that accepts writes from anonymous callers.
 *
 * It has to: an error raised before sign-in has no session, and those are the
 * reports the log exists for — a failed sign-in, a build whose API address no
 * longer answers. What stands in for a guard is everything below.
 */

const entry = (overrides: Partial<ReportClientErrorsDto['entries'][number]> = {}) => ({
  id: 'entry-1',
  message: 'Something went wrong',
  at: '2026-09-04T10:00:00.000Z',
  ...overrides,
});

const body = (overrides: Partial<ReportClientErrorsDto> = {}): ReportClientErrorsDto =>
  ({
    installId: 'install-1',
    source: 'MOBILE',
    entries: [entry()],
    ...overrides,
  }) as ReportClientErrorsDto;

function build() {
  const prisma = {
    clientErrorReport: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  return { service: new ClientErrorsService(prisma as never), prisma };
}

describe('redacting what a client sends', () => {
  it('strips a bearer token, scheme and all', () => {
    // The single most likely secret to appear in an API error. Without the
    // scheme-prefixed pass, only the word "Bearer" is replaced.
    expect(redact('failed: Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
  });

  it('strips a JWT wherever it appears', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature';

    // On its own, with nothing to announce it — the case the JWT rule exists
    // for, since a raw token in a message carries no label.
    expect(redact(`session ${jwt} expired`)).toContain('[redacted-jwt]');

    // Preceded by a trigger word it is caught twice: the JWT rule replaces it,
    // then the `token <value>` rule replaces that. Different marker, same
    // outcome, and the outcome is the only thing worth asserting.
    expect(redact(`token ${jwt} expired`)).not.toContain('signature');
  });

  it('strips a token carried in a query string', () => {
    expect(redact('GET /x?access_token=abc123&y=1')).not.toContain('abc123');
  });

  it('leaves an ordinary message alone', () => {
    // Over-redaction makes the log useless, which is its own failure.
    const message = 'The TexasRenters server did not accept the sign-in (HTTP 530).';
    expect(redact(message)).toBe(message);
  });
});

describe('accepting a report', () => {
  it('redacts on the way in, whatever the client did', async () => {
    // The client redacts too. This repeats it because the endpoint is open: an
    // old build, or something nobody wrote, must not be able to put a live
    // token in a table administrators read.
    const { service, prisma } = build();

    await service.report(body({ entries: [entry({ message: 'Bearer sk-live-123' })] }), {});

    const written = prisma.clientErrorReport.createMany.mock.calls[0][0].data[0];
    expect(written.message).not.toContain('sk-live-123');
  });

  it('never takes identity from the body', async () => {
    // A caller that could name its own organization could write into somebody
    // else's log. Identity comes from the token the controller verified, and
    // from nowhere else.
    const { service, prisma } = build();

    await service.report(
      { ...body(), organizationId: 'someone-elses-org', authUserId: 'someone-else' } as never,
      { organizationId: null, authUserId: null },
    );

    const written = prisma.clientErrorReport.createMany.mock.calls[0][0].data[0];
    expect(written.organizationId).toBeNull();
    expect(written.authUserId).toBeNull();
  });

  it('keeps an unauthenticated report rather than refusing it', async () => {
    // The whole point. A sign-in that fails has no session, and a log that
    // required one would be empty exactly when it mattered.
    const { service } = build();
    await expect(service.report(body(), {})).resolves.toEqual({ accepted: 1, duplicates: 0 });
  });

  it('deduplicates, so a re-sent log is free', async () => {
    // The client flush is at-least-once: it re-sends anything it has not had
    // acknowledged rather than tracking delivery itself.
    const { service, prisma } = build();
    await service.report(body(), {});
    expect(prisma.clientErrorReport.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('refuses a client that files far too often', async () => {
    const { service } = build();
    // The cap is per install, so one looping handset cannot silence the others
    // sharing an office address.
    for (let i = 0; i < 12; i += 1) await service.report(body(), {});

    await expect(service.report(body(), {})).rejects.toMatchObject({
      status: 429,
      code: 'TOO_MANY_ERROR_REPORTS',
    });
  });

  it('counts a different install separately', async () => {
    const { service } = build();
    for (let i = 0; i < 12; i += 1) await service.report(body({ installId: 'noisy' }), {});

    // A second handset is unaffected by the first one's crash loop.
    await expect(service.report(body({ installId: 'quiet' }), {})).resolves.toMatchObject({
      accepted: 1,
    });
  });
});

describe('reading the log back', () => {
  it('is not scoped to one organization', async () => {
    // Deliberate: an unauthenticated report belongs to no organization, so a
    // tenant scope would hide exactly the rows this was built for. Reading is
    // gated on `system:manage`, which is an operator permission.
    const { service, prisma } = build();
    await service.list({});
    expect(prisma.clientErrorReport.findMany.mock.calls[0][0].where.organizationId).toBeUndefined();
  });

  it('caps how much can be asked for at once', async () => {
    const { service, prisma } = build();
    await service.list({ take: 10_000 });
    expect(prisma.clientErrorReport.findMany.mock.calls[0][0].take).toBeLessThanOrEqual(201);
  });

  it('shows the newest first', async () => {
    const { service, prisma } = build();
    await service.list({});
    expect(prisma.clientErrorReport.findMany.mock.calls[0][0].orderBy).toEqual({
      receivedAt: 'desc',
    });
  });
});
