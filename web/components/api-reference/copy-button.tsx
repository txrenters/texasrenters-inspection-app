'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * Copy one short string, with the confirmation shown on the button itself.
 *
 * The tick reverts on a timer, so the control never claims a stale success —
 * and it resets when `value` changes, because a button still reading "Copied"
 * beside a different endpoint is worse than no feedback at all.
 */
export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => setCopied(false), [value]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access is refused in some embedded contexts. The text beside
      // this button is selectable, so failing quietly beats an error nobody can
      // act on.
    }
  };

  return (
    <Button
      aria-label={copied ? 'Copied' : `${label}: ${value}`}
      className={className}
      onClick={() => void copy()}
      size="sm"
      variant="ghost"
    >
      {copied ? <CheckIcon aria-hidden className="text-success" /> : <CopyIcon aria-hidden />}
      {copied ? 'Copied' : label}
    </Button>
  );
}
