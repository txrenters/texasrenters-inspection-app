import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';

import { Providers } from '@/components/providers';
import { Toaster } from '@/components/ui/sonner';

import './globals.css';

/**
 * The console had no type stack at all, so it rendered in whatever the operating
 * system happened to supply: Segoe UI on Windows, Helvetica on macOS, something
 * else again on Linux. Line lengths, table column widths and badge sizes all
 * shifted per machine, which is why the same screen never quite matched between
 * two people looking at it.
 *
 * Inter is chosen for the boring reason: it was drawn for dense UI at small
 * sizes, and this console is dense UI at small sizes.
 *
 * `variable` rather than a direct class so Tailwind's font-sans token picks it
 * up in globals.css, which keeps every component on the token instead of on a
 * hardcoded family.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'TexasRenters Admin', template: '%s | TexasRenters Admin' },
  description: 'TexasRenters inspection operations administrator application',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `suppressHydrationWarning` is required by next-themes: it writes the
    // resolved class onto <html> before React hydrates, which is precisely the
    // mismatch this suppresses. Nothing else on the page relies on it.
    <html className={inter.variable} lang="en" suppressHydrationWarning>
      {/*
        `tabular-nums` on the body, not sprinkled per component.
        This console is counts, durations and walkthrough timestamps. With
        proportional figures a column of "0:33 / 0:46 / 1:19" jitters as the
        digits change width, and an area list whose counts shift by a pixel per
        render reads as noise. Lining figures hold the column still.
      */}
      <body className="font-sans antialiased [font-variant-numeric:tabular-nums]">
        <Providers>
          {children}
          {/* Single notification surface for the whole application. */}
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
