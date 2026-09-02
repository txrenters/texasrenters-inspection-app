'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * What is in a search box whose query lives in the URL.
 *
 * List pages keep their query in the address bar, so the field used to be
 * `value={state.q}` where that comes from `useSearchParams()`. That makes a
 * keystroke a round trip: `onChange` calls `router.replace`, which is
 * asynchronous, and until it commits the value prop is still the *previous*
 * string — which React writes back into the DOM input, undoing the character
 * just typed and putting the caret at the end. Type slowly and every letter
 * survives because the URL settles between them; type at speed and letters
 * vanish. That is the "search bar won't let you type fast" report.
 *
 * So the input owns its text and the URL becomes a mirror of it. Callers still
 * hear every keystroke and still decide when to issue a request; only the
 * rendering of the field stops waiting on the router.
 *
 * The mirror does have to push back sometimes: "Clear all", a filter chip's ✕
 * and the browser's back button all change the query with nobody typing.
 * Telling those apart from our own keystroke arriving late is what `settled` is
 * for. While a keystroke is in flight every incoming value is stale by
 * definition, *including the intermediate ones* — typing "ab" quickly sees the
 * prop land on "a" first, and adopting that would reintroduce the exact bug
 * this removes. Once the prop matches what was last emitted the mirror has
 * caught up, and the next difference is somebody else's doing.
 *
 * Used by `ListToolbar` and by the pages that draw their own search field.
 */
export function useSearchText(search: string, onSearch: (value: string) => void) {
  const [text, setText] = useState(search);
  const emitted = useRef(search);
  const settled = useRef(true);

  useEffect(() => {
    if (search === emitted.current) {
      settled.current = true;
      return;
    }
    if (!settled.current) return;
    emitted.current = search;
    setText(search);
  }, [search]);

  const change = (value: string) => {
    // Set before emitting, so the field repaints from this render rather than
    // waiting on the router.
    setText(value);
    emitted.current = value;
    settled.current = false;
    onSearch(value);
  };

  return [text, change] as const;
}
