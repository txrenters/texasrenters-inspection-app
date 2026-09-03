'use client';

import { useEffect } from 'react';

import { reportError } from '@/lib/error-reporter';

/**
 * The last resort: the shell itself failed.
 *
 * Next replaces the entire document here, so this file has to render its own
 * `<html>` and `<body>` and cannot use the console's providers, theme or
 * components — none of them are mounted. That is why the markup below is plain
 * and inline-styled rather than using the design system.
 *
 * It still reports, which is the point. A failure this total is the one nobody
 * can describe afterwards, because there is nothing left on screen to describe.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, `global${error.digest ? `:${error.digest}` : ''}`, true);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          margin: 0,
          padding: '3rem 1.5rem',
          lineHeight: 1.5,
        }}
      >
        <main style={{ maxWidth: '32rem', margin: '0 auto' }}>
          <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.5rem' }}>Something went wrong</h1>
          <p style={{ margin: '0 0 1rem', color: '#555' }}>
            The problem has been reported automatically. Reloading usually clears it.
          </p>
          {error.digest ? (
            <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', color: '#555' }}>
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            onClick={reset}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1rem',
              cursor: 'pointer',
              border: '1px solid #ccc',
              borderRadius: '0.375rem',
              background: '#fff',
            }}
            type="button"
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
