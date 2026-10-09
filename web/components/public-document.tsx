import Link from 'next/link';
import type { ReactNode } from 'react';

import { BrandLockup } from '@/components/auth-layout';
import { ThemeToggleInline } from '@/components/theme-toggle';

/**
 * Who to write to about the app, as the company already publishes it.
 *
 * The same inbox, number and address texasrenters.com/privacy-policy gives for
 * privacy questions, so the app's pages do not open a second channel nobody
 * watches.
 */
export const CONTACT = {
  company: 'TexasRenters.com, LLC',
  email: 'info@texasrenters.com',
  phone: '(281) 407-3818',
  phoneHref: 'tel:+12814073818',
  address: '5225 Katy Fwy Ste 545, Houston, TX 77007',
} as const;

/**
 * The frame for the pages anyone may read without signing in.
 *
 * The App Store listing links to the privacy policy and the support page, and
 * App Review opens both before it approves a build, so they sit outside the
 * admin guard in `middleware.ts`. Same lock-up as the sign-in screen, but a
 * reading column rather than a form card: these are documents, read top to
 * bottom on a phone as often as on a desk.
 */
export function PublicDocument({
  title,
  updated,
  children,
}: {
  title: string;
  /** Shown as "Last updated …"; a policy without a date is not one anyone can rely on. */
  updated?: string;
  children: ReactNode;
}) {
  return (
    <main className="bg-muted/40 relative min-h-dvh px-4 py-12">
      <div className="absolute top-4 right-4">
        <ThemeToggleInline />
      </div>

      <div className="mx-auto w-full max-w-2xl space-y-6">
        {/* The same calm mark as the sign-in screen (console-development). */}
        <Link
          aria-label="TexasRenters Inspection support"
          className="focus-visible:ring-ring/50 mx-auto flex w-fit rounded-md outline-none focus-visible:ring-[3px]"
          href="/support"
        >
          <BrandLockup />
        </Link>

        <article className="bg-card rounded-xl border p-6 sm:p-8">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
          {updated ? <p className="text-muted-foreground mt-1 text-sm">Last updated {updated}</p> : null}
          {/* Arbitrary variants rather than a typography plugin: two pages of
              plain prose do not justify a dependency. */}
          <div className="mt-6 space-y-7 text-[0.9375rem] leading-7 text-pretty [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight [&_section]:space-y-3 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
            {children}
          </div>
        </article>

        <nav className="text-muted-foreground flex justify-center gap-4 text-sm">
          <Link className="hover:text-foreground" href="/privacy">
            Privacy policy
          </Link>
          <Link className="hover:text-foreground" href="/support">
            Support
          </Link>
        </nav>
      </div>
    </main>
  );
}

/** The contact block both pages end with. */
export function ContactDetails() {
  return (
    <ul>
      <li>
        Email: <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
      </li>
      <li>
        Phone: <a href={CONTACT.phoneHref}>{CONTACT.phone}</a>
      </li>
      <li>
        Mail: {CONTACT.company}, {CONTACT.address}
      </li>
    </ul>
  );
}
