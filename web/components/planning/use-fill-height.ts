'use client';

import { useEffect, useState } from 'react';

/** Where the map and its list sit side by side: Tailwind's `lg`. */
const SIDE_BY_SIDE = '(min-width: 1024px)';

/**
 * The height that fills the window below where an element starts, on a screen
 * wide enough for the map and its list side by side; null on a narrower one,
 * where the page stacks them and scrolls.
 *
 * The groups map was a fixed 36rem, which on a large monitor left the bottom
 * third of the window empty (the office, 2026-10-01). Measured when the page
 * opens and whenever the window changes size -- never on scroll, or the map
 * would grow and shrink as the page moved.
 */
export function useFillHeight<T extends HTMLElement>(options: { min?: number; bottom?: number } = {}) {
  const { min = 480, bottom = 16 } = options;
  // A callback ref, so an element that appears later -- a view switched to -- is measured too.
  const [element, setElement] = useState<T | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    // A test page has no media queries: it keeps the CSS height.
    if (!element || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(SIDE_BY_SIDE);
    const measure = () => {
      if (!query.matches) {
        setHeight(null);
        return;
      }
      const top = element.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(min, Math.floor(window.innerHeight - top - bottom)));
    };
    measure();
    window.addEventListener('resize', measure);
    query.addEventListener('change', measure);
    return () => {
      window.removeEventListener('resize', measure);
      query.removeEventListener('change', measure);
    };
  }, [bottom, element, min]);

  return { ref: setElement, height };
}
