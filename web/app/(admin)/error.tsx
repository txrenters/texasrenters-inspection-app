'use client';

import { useEffect } from 'react';
import { AlertTriangleIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { reportError } from '@/lib/error-reporter';

/**
 * What a reader sees when a page throws, and what we learn from it.
 *
 * Before this there was neither half. A render error replaced the console with
 * Next's default screen and the cause lived only in the reader's devtools — the
 * production `Minified React error #310` that took an afternoon was reported as
 * "the page is blank", because that is genuinely all anyone could see.
 *
 * Scoped to `(admin)` rather than the root so the shell, the sidebar and the
 * session survive: one broken page should not sign anybody out or lose their
 * place. `global-error.tsx` covers the case where the shell itself is what
 * failed.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // `digest` is the only handle on a minified production stack; without it a
    // report cannot be matched to the server's own log line.
    reportError(error, `admin-page${error.digest ? `:${error.digest}` : ''}`, true);
  }, [error]);

  return (
    <div className="p-6">
      <Alert variant="destructive">
        <AlertTriangleIcon />
        <AlertTitle>This page could not be displayed</AlertTitle>
        <AlertDescription>
          <p>
            The problem has been reported automatically — nobody needs to write it down. Everything
            else in the console still works.
          </p>
          {error.digest ? (
            <p className="mt-2 font-mono text-xs">Reference: {error.digest}</p>
          ) : null}
        </AlertDescription>
      </Alert>
      <div className="mt-4 flex gap-2">
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
