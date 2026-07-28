import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, letting later Tailwind utilities win over earlier ones.
 *
 * During the migration a component may carry both a legacy class and Tailwind
 * utilities; `twMerge` only de-duplicates Tailwind's own conflicts and leaves
 * unknown class names untouched, so legacy classes pass through unchanged.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
