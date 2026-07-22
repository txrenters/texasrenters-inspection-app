import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Providers } from '@/components/providers';
import { themeBootstrapScript } from '@/lib/theme-script';

import './globals.css';
import './auth.css';

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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
