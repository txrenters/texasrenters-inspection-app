import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Background work must establish a tenant context, and nothing else enforces it.
 *
 * Row-level security is on for `Inspection`, `OrganizationMember` and
 * `InspectionAssignment`. A request inherits its context from the interceptor;
 * a cron tick and a webhook processed after the response have no request. An
 * unwrapped background run therefore reads an *empty* database and reports a
 * clean, busy-looking result — 215 visits seen, nothing done — because every
 * branch takes the "no change" path rather than erroring.
 *
 * That is what happened on the first real cron tick, and it is invisible in
 * types, in lint, and in any test that mocks Prisma. Asserting on the source is
 * blunt, but it is the only thing that catches the omission.
 */
const read = (...parts: string[]) => readFileSync(join(__dirname, '..', 'src', ...parts), 'utf8');

const SCHEDULER = read('workers', 'jobber-sync', 'jobber-sync.scheduler.ts');
const WEBHOOK = read('integrations', 'jobber', 'jobber.webhook.service.ts');

describe('background Jobber work runs inside a tenant context', () => {
  it('wraps the scheduled pull', () => {
    expect(SCHEDULER).toMatch(/withTenant\(organizationId, \(\) => this\.worker\.run\(organizationId\)\)/);
  });

  it('wraps the outbox drain on the same tick', () => {
    expect(SCHEDULER).toMatch(/withTenant\(organizationId, \(\) => this\.outbound\.run\(organizationId\)\)/);
  });

  it('wraps webhook processing, which also has no request to inherit from', () => {
    expect(WEBHOOK).toMatch(/withTenant\(connection\.organizationId,/);
  });

  it('matches how the Propertyware coordinator has always done it', () => {
    // The precedent existed and this integration did not follow it. Named here
    // so the next background worker copies the right thing.
    const propertyware = read('workers', 'propertyware-sync', 'propertyware-sync.coordinator.ts');
    expect(propertyware).toContain('withTenant');
  });
});
