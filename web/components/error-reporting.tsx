'use client';

import { useEffect } from 'react';

import { installGlobalErrorHandlers } from '@/lib/error-reporter';

/**
 * Starts catching what React never sees.
 *
 * Mounted in the root layout rather than the admin one: an error on the login
 * page is worth as much as one behind it, and a reader who cannot sign in is
 * exactly the person who cannot tell anybody what they saw.
 *
 * Renders nothing. `installGlobalErrorHandlers` is idempotent, so the remount
 * Next.js performs on navigation does not double-report.
 */
export function ErrorReporting() {
  useEffect(() => {
    installGlobalErrorHandlers();
  }, []);
  return null;
}
