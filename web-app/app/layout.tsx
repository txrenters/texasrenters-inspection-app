import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Providers } from '@/components/providers';
import { Toaster } from '@/components/ui/sonner';
import { themeBootstrapScript } from '@/lib/theme-script';

// globals.css first: it declares the CSS custom properties that tailwind.css
// maps onto shadcn's token names, and its selectors must lose to Tailwind
// utilities during the migration.
import './globals.css';
import './auth.css';
import './tailwind.css';

export const metadata: Metadata = {
  title: { default: 'TexasRenters Admin', template: '%s | TexasRenters Admin' },
  description: 'TexasRenters inspection operations administrator application',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body>
        <Providers>
          {children}
          {/* Single notification surface for the whole application. */}
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
