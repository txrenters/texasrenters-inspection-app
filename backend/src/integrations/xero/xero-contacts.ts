import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { PrismaService } from '../../common/prisma.service';
import { xeroValidationMessages, type XeroClient } from './xero.client';
import { XeroError } from './xero.errors';

/** Xero takes up to 50 contacts in one call. */
const BATCH = 50;
/** Contacts looked up by name in one go, after Xero said the name was taken. */
export const MAX_CONTACT_LOOKUPS = 20;

const validationErrors = z.array(z.object({ Message: z.string() })).nullish();
const contactsSchema = z.object({
  Contacts: z.array(z.object({ ContactID: z.string().nullish(), Name: z.string().nullish(), StatusAttributeString: z.string().nullish(), ValidationErrors: validationErrors })),
});

/** What Xero answers for each thing in a batch: an id, or why it refused it. */
export type XeroAnswer = {
  ContactID?: string | null;
  InvoiceID?: string | null;
  PaymentID?: string | null;
  StatusAttributeString?: string | null;
  ValidationErrors?: { Message: string }[] | null;
};

export const refused = (answer: XeroAnswer) => answer.StatusAttributeString === 'ERROR' || Boolean(answer.ValidationErrors?.length);
export const said = (answer: XeroAnswer) => xeroValidationMessages({ ValidationErrors: answer.ValidationErrors ?? [] }) ?? 'Xero refused it without saying why.';
const keyOf = (organizationId: string, path: string, body: unknown) => createHash('sha256').update(`${organizationId}|${path}|${JSON.stringify(body)}`).digest('hex');
/** Xero's `where` filter: a name in double quotes, its own quotes and backslashes escaped. */
const nameFilter = (name: string) => `Name=="${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** A client's contact in Xero, or why it could not be had. */
export type XeroContactFound = { id: string } | { problem: string };

/**
 * The Xero contact for each client (`clientKey` to its name): linked already,
 * made now (50 a call), or -- when Xero says the name is taken, as it is for a
 * contact the office made by hand -- found by its name and linked. The
 * sender's, for invoices (2026-11-10), and the New project dialog's, for a
 * project made before the property's first invoice (2026-11-13).
 */
export async function xeroContacts(
  prisma: PrismaService,
  client: XeroClient,
  organizationId: string,
  tenantId: string,
  byKey: ReadonlyMap<string, string>,
): Promise<Map<string, XeroContactFound>> {
  const found = new Map<string, XeroContactFound>();
  if (!byKey.size) return found;
  const links = await prisma.xeroContactLink.findMany({
    where: { organizationId, xeroTenantId: tenantId, clientKey: { in: [...byKey.keys()] } },
    select: { clientKey: true, xeroContactId: true },
  });
  for (const link of links) found.set(link.clientKey, { id: link.xeroContactId });
  const missing = [...byKey.entries()].filter(([key]) => !found.has(key));
  const link = (clientKey: string, xeroContactId: string, name: string) =>
    prisma.xeroContactLink.createMany({ data: [{ organizationId, xeroTenantId: tenantId, clientKey, xeroContactId, name }], skipDuplicates: true });
  let lookups = 0;
  for (let start = 0; start < missing.length; start += BATCH) {
    const batch = missing.slice(start, start + BATCH);
    const body = { Contacts: batch.map(([, name]) => ({ Name: name })) };
    const path = '/Contacts?summarizeErrors=false';
    let answers: XeroAnswer[];
    try {
      answers = (await client.post(organizationId, tenantId, path, body, contactsSchema, keyOf(`${organizationId}:${tenantId}`, path, body))).Contacts;
    } catch (error) {
      if (error instanceof XeroError && error.code === 'XERO_VALIDATION') {
        for (const [key] of batch) found.set(key, { problem: error.message });
        continue;
      }
      throw error;
    }
    for (const [index, [key, name]] of batch.entries()) {
      const answer = answers[index];
      if (answer?.ContactID && !refused(answer)) {
        await link(key, answer.ContactID, name);
        found.set(key, { id: answer.ContactID });
        continue;
      }
      const reason = answer ? said(answer) : 'Xero did not answer for it.';
      if (/already (assigned|exists|in use)/i.test(reason) && lookups < MAX_CONTACT_LOOKUPS) {
        lookups++;
        const same = (await client.get(organizationId, tenantId, `/Contacts?where=${encodeURIComponent(nameFilter(name))}`, contactsSchema)).Contacts.filter(
          (contact) => contact.ContactID,
        );
        if (same.length === 1) {
          await link(key, same[0]!.ContactID!, name);
          found.set(key, { id: same[0]!.ContactID! });
          continue;
        }
        found.set(key, { problem: same.length ? `Xero has ${same.length} contacts named “${name}”: merge them in Xero.` : `Xero says “${name}” is taken but did not find it.` });
        continue;
      }
      found.set(key, { problem: `Xero refused the contact “${name}”: ${reason}` });
    }
  }
  return found;
}
