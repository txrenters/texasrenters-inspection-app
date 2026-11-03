import type { Metadata } from 'next';
import { Geist, Geist_Mono, Inter, Poppins } from 'next/font/google';
import type { ReactNode } from 'react';

import { ErrorReporting } from '@/components/error-reporting';
import { Providers } from '@/components/providers';
import { Toaster } from '@/components/ui/sonner';

import './globals.css';

/**
 * Two families, because this console is two kinds of text.
 *
 * Geist for the interface: drawn for dense UI at small sizes, with open
 * counters that hold up at the 12px this application leans on heavily.
 *
 * Geist Mono for anything read *down a column* — inspection ids, timestamps,
 * durations, counts, money. `tabular-nums` alone fixes digit width but not the
 * ragged left edge of mixed alphanumeric ids, and an operations console is
 * mostly people scanning columns for the row that is wrong. Pairing the two is
 * also why they are the same superfamily: the mono is metrically related, so a
 * mono cell and a sans cell in the same row sit on the same baseline rhythm.
 *
 * `variable` rather than a direct class so Tailwind's font-sans and font-mono
 * tokens pick them up in globals.css, which keeps every component on the token
 * instead of on a hardcoded family.
 */
const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

/**
 * The Jobber-style shell's two faces (components/jobber-shell): Inter for the
 * interface, which is what Jobber itself is set in, and Poppins for page
 * titles, the open-licence face Jobber's design system falls back to for its
 * own display type. Both are SIL Open Font Licence.
 *
 * `preload: false`: only the Jobber shell uses them, so a classic-console page
 * must not download them. A face with no preload is fetched the first time
 * something on the page actually renders in it.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
  preload: false,
});

const poppins = Poppins({
  subsets: ['latin'],
  variable: '--font-poppins',
  weight: ['600', '700', '800'],
  display: 'swap',
  preload: false,
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
    <html
      className={`${geist.variable} ${geistMono.variable} ${inter.variable} ${poppins.variable}`}
      lang="en"
      suppressHydrationWarning
    >
      {/*
        `tabular-nums` on the body, not sprinkled per component.
        This console is counts, durations and walkthrough timestamps. With
        proportional figures a column of "0:33 / 0:46 / 1:19" jitters as the
        digits change width, and an area list whose counts shift by a pixel per
        render reads as noise. Lining figures hold the column still.
      */}
      <body className="font-sans antialiased [font-variant-numeric:tabular-nums]">
        <Providers>
          {/* Catches uncaught errors and unhandled rejections everywhere,
              including the login page. Renders nothing. */}
          <ErrorReporting />
          {children}
          {/* Single notification surface for the whole application. */}
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
