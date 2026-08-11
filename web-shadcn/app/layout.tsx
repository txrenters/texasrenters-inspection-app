import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Providers } from '@/components/providers';
import { Toaster } from '@/components/ui/sonner';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'TexasRenters Admin', template: '%s | TexasRenters Admin' },
  description: 'TexasRenters inspection operations administrator application',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `suppressHydrationWarning` is required by next-themes: it writes the
    // resolved class onto <html> before React hydrates, which is precisely the
    // mismatch this suppresses. Nothing else on the page relies on it.
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <Providers>
          {children}
          {/* Single notification surface for the whole application. */}
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
