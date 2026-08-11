'use client';

import { CheckIcon, EyeIcon, EyeOffIcon, XIcon } from 'lucide-react';
import { useState, type ComponentProps } from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * A password field with a reveal control.
 *
 * Not present in the old app, where a mistyped password could only be found by
 * failing to sign in — and on the reset screen, where two fields must match and
 * neither can be read, by failing twice.
 */
export function PasswordInput({ className, ...props }: ComponentProps<typeof Input>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} className={cn('pr-10', className)} type={visible ? 'text' : 'password'} />
      <button
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute top-1/2 right-1 -translate-y-1/2 rounded-md p-2 transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
        onClick={() => setVisible((current) => !current)}
        tabIndex={-1}
        type="button"
      >
        {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
      </button>
    </div>
  );
}

/**
 * The password policy, checked live.
 *
 * The old form reported only the *first* unmet rule, and only after submitting —
 * so satisfying the length requirement revealed the capital-letter one, and so
 * on, one failed submit at a time. All five are listed here from the start and
 * tick as they are met.
 */
export function PasswordRules({
  value,
  rules,
}: {
  value: string;
  rules: ReadonlyArray<{ test: (value: string) => boolean; message: string }>;
}) {
  return (
    <ul className="grid gap-1.5" aria-label="Password requirements">
      {rules.map((rule) => {
        const met = rule.test(value);
        return (
          <li
            className={cn(
              'flex items-center gap-2 text-xs transition-colors',
              met ? 'text-success' : 'text-muted-foreground',
            )}
            key={rule.message}
          >
            {met ? (
              <CheckIcon aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <XIcon aria-hidden className="size-3.5 shrink-0 opacity-40" />
            )}
            <span>{rule.message}</span>
            <span className="sr-only">{met ? ' — met' : ' — not met'}</span>
          </li>
        );
      })}
    </ul>
  );
}
